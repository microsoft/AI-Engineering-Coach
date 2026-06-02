/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* AI Settings page renderer */

import { rpc } from './shared';
import { html, render } from './render';
import { SVG } from './svg-icons';

interface LmSettings {
  preferredModelId: string;
  availableModels: Array<{ id: string; name: string; family: string; vendor: string }>;
}

export async function renderSettings(container: HTMLElement): Promise<void> {
  render(html`
    <div class="settings-page">
      <div class="settings-hero">
        <div class="settings-hero-left">
          <div class="settings-hero-icon">${SVG.gear}</div>
          <div>
            <h2 class="settings-hero-title">AI Settings</h2>
            <p class="settings-hero-sub">Configure your AI providers and coaching preferences.</p>
          </div>
        </div>
      </div>

      <div class="settings-content">
        <div class="settings-section">
          <h3 class="settings-section-title">${SVG.robot} Language Model Provider</h3>
          <div class="settings-card">
            <p class="settings-card-desc">
              Select the AI model to power dashboard features like <strong>Quizzes</strong>, <strong>Skill Generation</strong>, and <strong>Context Reviews</strong>.
              The list shows all models provided by your installed VS Code extensions (e.g. Gemini, Claude, Copilot).
            </p>
            
            <div id="lm-settings-container" class="settings-loading">
              Loading AI providers...
            </div>
          </div>
        </div>
        
        <div class="settings-section">
          <h3 class="settings-section-title">${SVG.shield} Local Rule Approvals</h3>
          <div class="settings-card">
            <p class="settings-card-desc">
              Manage permissions for custom DSL rules and metrics stored in your workspace.
            </p>
            <button class="settings-btn" onclick=${() => rpc('reviewLocalRules')}>
              ${SVG.eye} Review Approvals
            </button>
          </div>
        </div>
      </div>
    </div>
  `, container);

  // Fetch and render settings detail
  try {
    const settings = await rpc<LmSettings>('getLmSettings');
    const containerInner = container.querySelector('#lm-settings-container');
    if (containerInner) {
      renderLmSettings(containerInner, settings);
    }
  } catch (error) {
    const containerInner = container.querySelector('#lm-settings-container');
    if (containerInner) {
      const msg = error instanceof Error ? error.message : String(error);
      render(html`<div class="settings-error">Failed to load AI providers: ${msg}</div>`, containerInner);
    }
  }
}

function renderLmSettings(container: HTMLElement, settings: LmSettings): void {
  const { preferredModelId, availableModels } = settings;
  
  const handleModelChange = async (ev: Event) => {
    const select = ev.target as HTMLSelectElement;
    const newId = select.value;
    try {
      await rpc('setLmSettings', { preferredModelId: newId });
      // Re-render to show success/update
    } catch (error) {
      alert(`Failed to save setting: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (availableModels.length === 0) {
    render(html`
      <div class="settings-empty">
        ${SVG.warning} No AI providers detected. 
        <div class="settings-empty-sub">
          Make sure you have an AI extension installed (like <strong>Gemini</strong>, <strong>Claude Dev</strong>, or <strong>GitHub Copilot</strong>) and that you are signed in.
        </div>
      </div>
    `, container);
    return;
  }

  render(html`
    <div class="settings-form">
      <div class="settings-field">
        <label for="model-select">Active AI Model:</label>
        <select id="model-select" class="settings-select" onchange=${handleModelChange}>
          <option value="">(Auto-select best available)</option>
          ${availableModels.map(m => html`
            <option value=${m.id} selected=${m.id === preferredModelId}>
              ${m.vendor}: ${m.name} [${m.family}]
            </option>
          `)}
        </select>
      </div>
      
      <div class="settings-info-box">
        ${SVG.info} 
        <span>
          The Coach prefers high-capability models like <strong>Gemini 2.0 Pro</strong> or <strong>Claude 3.5 Sonnet</strong> by default. 
          Manually selecting a model will override this logic.
        </span>
      </div>
    </div>
  `, container);
}
