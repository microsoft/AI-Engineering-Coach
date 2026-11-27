/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ActivityBar, By, EditorView, error, until, VSBrowser, WebView, WebviewView, Workbench } from 'vscode-extension-tester';
import { saveSnapshot } from './snapshots';

const READY_TIMEOUT = 60_000;
const STALE_OUTER_FRAME = 'WebviewMixin.switchToFrame: outer iframe became stale during frame switch.';

/**
 * Errors from a webview frame that VS Code replaced or hasn't finished loading; polling again
 * reacquires it. ExTester rethrows a stale outer frame as a plain Error, matched by its message.
 * Anything else, such as a disconnected driver, is a real failure.
 */
function isTransientFrameError(err: unknown): boolean {
  return err instanceof error.StaleElementReferenceError || err instanceof error.NoSuchFrameError
    || err instanceof error.NoSuchElementError
    || (err instanceof Error && err.message.startsWith(STALE_OUTER_FRAME));
}

export class Dashboard {
  private currentWebview: WebView | undefined;

  private get webview(): WebView {
    return this.currentWebview ??= new WebView();
  }

  async command(title: 'Open Dashboard' | 'Reload Data'): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const previousDocumentId = title === 'Reload Data' && this.currentWebview
      ? await driver.findElement(By.css('html')).getId()
      : undefined;
    await driver.switchTo().defaultContent();
    await this.runCommand(`AI Engineer Coach: ${title}`);
    // Page-object constructors resolve immediately; wait until the editor exists first.
    await driver.wait(until.elementLocated(By.css('.editor-instance')), READY_TIMEOUT);
    await this.waitForWebview(previousDocumentId);
  }

  /** Runs a command from the palette once the palette lists it and stays open. On a cold start the workbench can still
   *  be activating its startup extensions: the palette then closes under the keystrokes, or doesn't list the command
   *  yet, and typing into it fails (`ElementNotInteractable`). The command runs only in a state where selecting it is
   *  possible; until then the palette is closed and opened again. */
  private async runCommand(command: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    await driver.wait(async () => {
      try {
        const prompt = await new Workbench().openCommandPrompt();
        await prompt.setText(`>${command}`);
        const labels = await Promise.all((await prompt.getQuickPicks()).map(item => item.getLabel()));
        if (labels.includes(command) && await prompt.isDisplayed()) {
          await prompt.selectQuickPick(command);
          return true;
        }
        await prompt.cancel().catch(() => undefined);
        return false;
      } catch (err: unknown) {
        if (err instanceof error.ElementNotInteractableError || err instanceof error.StaleElementReferenceError
          || err instanceof error.NoSuchElementError) {
          return false;
        }
        throw err;
      }
    }, READY_TIMEOUT, `Waiting for the command palette to list "${command}"`);
  }

  private async waitForWebview(previousDocumentId?: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + READY_TIMEOUT;
    await driver.wait(async () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      // Reload replaces the inner iframe; reacquire it from the workbench on each poll.
      await driver.switchTo().defaultContent();
      try {
        const webview = new WebView();
        await webview.switchToFrame(remaining);
        const documentId = await driver.findElement(By.css('html')).getId();
        if (documentId === previousDocumentId) return false;
        this.currentWebview = webview;
        return true;
      } catch (err: unknown) {
        if (isTransientFrameError(err)) return false;
        throw err;
      }
    }, READY_TIMEOUT, previousDocumentId
      ? 'Waiting for the replacement webview after reload'
      : 'Waiting for the dashboard webview');
  }

  async open(): Promise<void> {
    await this.command('Open Dashboard');
  }

  /** Runs an AI Engineer Coach command that opens something other than the dashboard. */
  async runCoachCommand(title: string): Promise<void> {
    await VSBrowser.instance.driver.switchTo().defaultContent();
    await this.runCommand(`AI Engineer Coach: ${title}`);
  }

  /** Waits for an editor tab whose title matches and returns that title. */
  async waitForEditor(pattern: RegExp): Promise<string> {
    const driver = VSBrowser.instance.driver;
    await driver.switchTo().defaultContent();
    const editors = new EditorView();
    let match: string | undefined;
    await driver.wait(async () => {
      match = (await editors.getOpenEditorTitles()).find(title => pattern.test(title));
      return match !== undefined;
    }, READY_TIMEOUT, `Expected an editor titled ${String(pattern)}`);
    if (match === undefined) throw new Error(`Expected an editor titled ${String(pattern)}`);
    return match;
  }

  async closeEditor(title: string): Promise<void> {
    const driver = VSBrowser.instance.driver;
    await driver.switchTo().defaultContent();
    const editors = new EditorView();
    await editors.closeEditor(title);
    await driver.wait(async () => !(await editors.getOpenEditorTitles()).includes(title), READY_TIMEOUT);
  }

  /**
   * Opens the AI Engineer Coach activity-bar view, then runs `action` inside its webview and
   * returns to the workbench.
   */
  async inActivityBarView<T>(action: (view: WebviewView) => Promise<T>): Promise<T> {
    await VSBrowser.instance.driver.switchTo().defaultContent();
    const control = await new ActivityBar().getViewControl('AI Engineer Coach');
    if (!control) throw new Error('The AI Engineer Coach activity-bar container is missing');
    const view = new WebviewView(await control.openView());
    // #whatsNew exists only in this view, so another ready webview is retried instead of read.
    return this.inFrame(view, '#whatsNew', () => action(view), 'the AI Engineer Coach activity-bar view');
  }

  /** Headings of the active Markdown preview, once it has rendered. */
  async markdownPreviewHeadings(): Promise<string[]> {
    await VSBrowser.instance.driver.switchTo().defaultContent();
    const view = new WebView();
    return this.inFrame(view, '.markdown-body h1', async () => Promise.all(
      (await view.findWebElements(By.css('.markdown-body h1, .markdown-body h2'))).map(heading => heading.getText())),
    'the rendered Markdown preview');
  }

  /**
   * Runs `action` inside `view`'s frame once it contains `marker`, then returns to the workbench.
   * Retries while frames load (until a webview is ready, another one can be the only ready frame)
   * and when VS Code replaces the frame, within one overall deadline. `action` may run again after
   * a transient error, so it must be safe to repeat.
   */
  private async inFrame<T>(view: WebView | WebviewView, marker: string, action: () => Promise<T>, what: string): Promise<T> {
    const driver = VSBrowser.instance.driver;
    const deadline = Date.now() + READY_TIMEOUT;
    let result: { value: T } | undefined;
    await driver.wait(async () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      try {
        await view.switchToFrame(remaining);
        await view.findWebElement(By.css(marker));
        result = { value: await action() };
        return true;
      } catch (err: unknown) {
        if (isTransientFrameError(err)) return false;
        throw err;
      } finally {
        await driver.switchTo().defaultContent();
      }
    }, READY_TIMEOUT, `Waiting for ${what}`);
    if (!result) throw new Error(`${what} did not load`);
    return result.value;
  }

  async snapshot(name: string, title: string): Promise<void> {
    const artifacts = process.env.AIC_E2E_ARTIFACTS;
    if (!artifacts) throw new Error('Missing isolated test artifact directory');
    const driver = VSBrowser.instance.driver;
    let previousCharts: string | undefined;
    // Canvas animations continue after the metrics and DOM become visible.
    await driver.wait(async () => {
      const charts = await driver.executeScript<string>(() =>
        JSON.stringify(Array.from(document.querySelectorAll('canvas'), canvas => canvas.toDataURL())));
      const stable = charts === previousCharts;
      previousCharts = charts;
      return stable;
    }, READY_TIMEOUT, 'Waiting for charts to finish rendering before the snapshot');
    await saveSnapshot(artifacts, { name, title }, await driver.takeScreenshot());
  }

  async close(): Promise<void> {
    await VSBrowser.instance.driver.switchTo().defaultContent();
    const editors = new EditorView();
    await editors.closeEditor('AI Engineer Coach');
    await VSBrowser.instance.driver.wait(async () =>
      !(await editors.getOpenEditorTitles()).includes('AI Engineer Coach'), READY_TIMEOUT);
    this.currentWebview = undefined;
  }

  /** Waits for the text, entering the webview again after each poll that doesn't find it. The extension can replace the
   *  whole page (its no-data and error pages do, once the dashboard page reported `ready`), and VS Code then swaps the
   *  inner iframe: a driver that entered the old one keeps polling a frame with no document, which finds nothing. */
  async waitForText(selector: string, expected: string, exact = false): Promise<void> {
    await VSBrowser.instance.driver.wait(async () => {
      try {
        const elements = await this.webview.findWebElements(By.css(selector));
        for (const element of elements) {
          const text = (await element.getText()).toLowerCase();
          const target = expected.toLowerCase();
          if (exact ? text === target : text.includes(target)) return true;
        }
      } catch (err: unknown) {
        if (!(err instanceof error.StaleElementReferenceError || err instanceof error.NoSuchElementError || err instanceof error.NoSuchFrameError
          || err instanceof error.NoSuchWindowError)) {
          throw err;
        }
      }
      // A poll that found nothing, or failed on the old frame: the next one starts from the webview's current frame.
      await this.reenter().catch((err: unknown) => {
        if (!(err instanceof error.StaleElementReferenceError || err instanceof error.NoSuchFrameError || err instanceof error.NoSuchElementError
          || (err instanceof Error && err.message.startsWith('WebviewMixin.switchToFrame: outer iframe became stale during frame switch.')))) {
          throw err;
        }
      });
      return false;
    }, READY_TIMEOUT, `Expected ${selector} to ${exact ? 'equal' : 'contain'} ${JSON.stringify(expected)}`);
  }

  /** Enters the webview's current inner frame. */
  private async reenter(): Promise<void> {
    const driver = VSBrowser.instance.driver;
    await driver.switchTo().defaultContent();
    const webview = new WebView();
    await webview.switchToFrame(READY_TIMEOUT);
    this.currentWebview = webview;
  }

  async expectCount(selector: string, expected: number): Promise<void> {
    await VSBrowser.instance.driver.wait(async () =>
      (await this.webview.findWebElements(By.css(selector))).length === expected,
    READY_TIMEOUT, `Expected ${expected} elements matching ${selector}`);
  }

  /** Waits until `selector` matches at least one element and none of them is displayed. */
  async expectHidden(selector: string): Promise<void> {
    await VSBrowser.instance.driver.wait(async () => {
      try {
        const elements = await this.webview.findWebElements(By.css(selector));
        if (elements.length === 0) return false;
        for (const element of elements) {
          if (await element.isDisplayed()) return false;
        }
        return true;
      } catch (err: unknown) {
        if (err instanceof error.StaleElementReferenceError) return false;
        throw err;
      }
    }, READY_TIMEOUT, `Expected ${selector} to be rendered but hidden`);
  }

  /** Waits until `selector` is a displayed, disabled control with the given tooltip. */
  async expectDisabled(selector: string, title: string): Promise<void> {
    await VSBrowser.instance.driver.wait(async () => {
      try {
        const element = await this.webview.findWebElement(By.css(selector));
        return await element.isDisplayed() && !(await element.isEnabled())
          && await element.getAttribute('title') === title;
      } catch (err: unknown) {
        if (err instanceof error.StaleElementReferenceError || err instanceof error.NoSuchElementError) return false;
        throw err;
      }
    }, READY_TIMEOUT, `Expected ${selector} to be displayed and disabled with the tooltip ${JSON.stringify(title)}`);
  }

  async scrollTo(selector: string): Promise<void> {
    const element = await this.webview.findWebElement(By.css(selector));
    await VSBrowser.instance.driver.executeScript((target: HTMLElement) =>
      target.scrollIntoView({ block: 'center', behavior: 'instant' }), element);
  }

  async click(selector: string): Promise<void> {
    await VSBrowser.instance.driver.wait(async () => {
      const elements = await this.webview.findWebElements(By.css(selector));
      return elements.length > 0 && await elements[0].isDisplayed();
    }, READY_TIMEOUT, `Expected visible control: ${selector}`);
    await (await this.webview.findWebElement(By.css(selector))).click();
  }

  async expectStats(expected: Record<string, string>): Promise<void> {
    for (const [label, value] of Object.entries(expected)) {
      await VSBrowser.instance.driver.wait(async () => {
        try {
          for (const stat of await this.webview.findWebElements(By.css('.dash-stat'))) {
            if ((await stat.findElement(By.css('.dash-stat-lbl')).getText()).toLowerCase() === label.toLowerCase()) {
              return await stat.findElement(By.css('.dash-stat-val')).getText() === value;
            }
          }
          return false;
        } catch (err: unknown) {
          if (err instanceof error.StaleElementReferenceError || err instanceof error.NoSuchElementError) return false;
          throw err;
        }
      }, READY_TIMEOUT, `Expected dashboard ${label}: ${value}`);
    }
    await this.expectHealthy();
  }

  async navigate(page: string, heading: string): Promise<void> {
    await this.click(`[data-page="${page}"]`);
    await this.waitForText('#content h1', heading, true);
  }

  async expectHealthy(): Promise<void> {
    const problems = await this.webview.findWebElements(By.css('.error-boundary, .error, .loading-screen, .loading-spinner'));
    for (const problem of problems) {
      if (await problem.isDisplayed()) throw new Error(`Dashboard is not ready: ${await problem.getText()}`);
    }
  }
}
