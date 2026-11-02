/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Rule markdown for the Rule Editor form: reads the fields the form shows, and writes changed fields back into
 * the rule in place, so the parts the form doesn't show (other front-matter keys, `# Tests` and other sections,
 * text around the detect block) survive a round trip.
 */

/** The fields the Rule Editor form shows, as its inputs hold them. */
export interface RuleFormFields {
  id: string;
  name: string;
  group: string;
  severity: string;
  scope: string;
  version: string;
  tags: string;
  thresholds: string;
  description: string;
  whenTriggered: string;
  howToImprove: string;
  examples: string;
  detect: string;
}

export type RuleFormField = keyof RuleFormFields;
type FrontmatterField = 'id' | 'name' | 'group' | 'severity' | 'scope' | 'version' | 'tags' | 'thresholds';
type SectionField = 'description' | 'whenTriggered' | 'howToImprove' | 'examples';

const FRONTMATTER_FIELDS: readonly FrontmatterField[] = ['id', 'name', 'group', 'severity', 'scope', 'version', 'tags', 'thresholds'];
const SECTION_HEADINGS: Record<SectionField, string> = {
  description: 'Description',
  whenTriggered: 'When Triggered',
  howToImprove: 'How to Improve',
  examples: 'Examples',
};
const SECTION_FIELDS = Object.keys(SECTION_HEADINGS) as SectionField[];
/** The fields for text sections, which the form can leave to the Source view (see `sourceOnlyFields`). */
export const TEXT_SECTION_FIELDS: readonly RuleFormField[] = SECTION_FIELDS;

/** What the form writes for a field left empty. */
const EMPTY_FIELD_DEFAULTS: Partial<Record<RuleFormField, string>> = {
  id: 'my-custom-rule',
  name: 'My Custom Rule',
  version: '1',
  description: 'Describe what this rule detects.',
  whenTriggered: '{{count}} occurrences detected ({{pct}} of requests).',
  howToImprove: 'Explain how to fix this anti-pattern.',
  examples: '"{{message}}..."',
  detect: 'scan: requests\nmatch: messageLength > 0\naggregate: count\ncheck: count >= 1',
};

/** A front-matter key with the indented and blank lines after it, or a section from its heading to the next one. */
interface Block {
  key: string;
  lines: string[];
}

const FRONTMATTER_RE = /^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n|$)/;
/** The logic of the first detect block, found the way the rule parser finds it. */
const DETECT_LOGIC_RE = /(```detect\s*\n)([\s\S]*?)(```)/;
/** A line that opens a detect block for the rule parser, which finds the marker anywhere, after a fence of any length. */
const DETECT_OPEN_LINE = /```detect\s*$/;
const BLANK = /^\s*$/;
/** Blank lines and comments, which the rule parser skips in front matter. */
const BLANK_OR_COMMENT = /^\s*(#.*)?$/;

/**
 * Converts CRLF and lone CR line endings to LF. Rules can reach the editor with CRLF endings (built-in rules
 * from a Windows checkout with `core.autocrlf`, or local rules saved on Windows), and the editor's parsers
 * expect LF.
 */
export function normalizeLineEndings(md: string): string {
  return md.replaceAll(/\r\n?/g, '\n');
}

function splitFrontmatter(md: string): { frontmatter: Block[] | null; body: string } {
  const match = FRONTMATTER_RE.exec(md);
  return match
    ? { frontmatter: frontmatterBlocks(match[1]), body: md.slice(match[0].length) }
    : { frontmatter: null, body: md };
}

function frontmatterBlocks(yaml: string): Block[] {
  const blocks: Block[] = [];
  for (const line of yaml.split('\n')) {
    const last = blocks.at(-1);
    // Like the rule parser, a comment doesn't end a key's nested block.
    if (last?.key && /^(\s|#|$)/.test(line)) last.lines.push(line);
    else blocks.push({ key: /^(\w[\w-]*):/.exec(line)?.[1] ?? '', lines: [line] });
  }
  return blocks;
}

/**
 * Splits a rule body at its headings the way the rule parser finds them: every line that starts with `#` and
 * whitespace, inside a code fence or not. The first block holds any text before the first heading.
 */
function sectionBlocks(body: string): Block[] {
  const blocks: Block[] = [{ key: '', lines: [] }];
  for (const line of body.split('\n')) {
    const heading = /^#+(\s.*)?$/.exec(line);
    if (heading) blocks.push({ key: (heading[1] ?? '').trim().toLowerCase(), lines: [line] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks;
}

/** The index of the last block for a key: like the rule parser, the last occurrence of a front-matter key wins. */
function lastBlockIndex(blocks: Block[], key: string): number {
  for (let at = blocks.length - 1; at >= 0; at--) if (blocks[at].key === key) return at;
  return -1;
}

/** The lines of a body's first detect block, as the rule parser finds it: from its marker to its closing fence. */
function detectBlockLines(body: string): { first: number; last: number } | null {
  const match = DETECT_LOGIC_RE.exec(body);
  if (!match) return null;
  const lineAt = (offset: number) => body.slice(0, offset).split('\n').length - 1;
  return { first: lineAt(match.index), last: lineAt(match.index + match[0].length) };
}

/**
 * The section blocks whose heading lies inside the detect block. The rule parser reads them as sections, but
 * rewriting one would rewrite part of the detection logic, so the form leaves them to the Source view.
 */
function sectionsInDetectBlock(body: string, blocks: Block[]): Set<Block> {
  const inside = new Set<Block>();
  const span = detectBlockLines(body);
  let line = 0;
  for (const block of blocks) {
    if (span && line > span.first && line <= span.last) inside.add(block);
    line += block.lines.length;
  }
  return inside;
}

/** The text-section fields the form shows but doesn't write: their section's heading is inside the detect block. */
export function sourceOnlyFields(markdown: string): Set<RuleFormField> {
  const { body } = splitFrontmatter(normalizeLineEndings(markdown));
  const blocks = sectionBlocks(body);
  const inside = sectionsInDetectBlock(body, blocks);
  return new Set(SECTION_FIELDS.filter(field => {
    const section = blocks.find(block => block.key === SECTION_HEADINGS[field].toLowerCase());
    return section !== undefined && inside.has(section);
  }));
}

function joinBlocks(blocks: Block[]): string {
  return blocks.flatMap(block => block.lines).join('\n');
}

/** How many lines at the end of `lines`, after the first `keep`, match `pattern`. */
function trailingCount(lines: string[], pattern: RegExp, keep = 1): number {
  let end = lines.length;
  while (end > keep && pattern.test(lines[end - 1])) end--;
  return lines.length - end;
}

/** Splits a text section's lines at its first detect block: the form edits the text before it and keeps the rest. */
function splitAtDetectBlock(lines: string[]): { text: string[]; rest: string[] } {
  const at = lines.findIndex(line => DETECT_OPEN_LINE.test(line));
  return at < 0 ? { text: lines, rest: [] } : { text: lines.slice(0, at), rest: lines.slice(at) };
}

/** Adds a section before the Detection Logic section, or at the end of the body. */
function insertSection(blocks: Block[], section: Block): void {
  const at = blocks.findIndex(block => block.key === 'detection logic');
  if (at >= 0) {
    blocks.splice(at, 0, section);
    return;
  }
  const last = blocks[blocks.length - 1].lines;
  if (last.length > 0 && last[last.length - 1] !== '') last.push('');
  blocks.push(section);
}

/** Writes the detect logic into the first detect block, or adds a block. Cleared logic leaves the block empty. */
function writeDetectLogic(body: string, logic: string): string {
  if (DETECT_LOGIC_RE.test(body)) {
    return body.replace(DETECT_LOGIC_RE, (_block, open: string, _logic: string, close: string) => `${open}${logic ? `${logic}\n` : ''}${close}`);
  }
  if (!logic) return body;
  const blocks = sectionBlocks(body);
  const fence = ['```detect', ...logic.split('\n'), '```'];
  const section = blocks.find(block => block.key === 'detection logic');
  if (section) section.lines.splice(section.lines.length - trailingCount(section.lines, BLANK), 0, ...fence);
  else insertSection(blocks, { key: 'detection logic', lines: ['# Detection Logic', ...fence, ''] });
  return joinBlocks(blocks);
}

/** The front-matter lines the form writes for a field. A field with no value and no default is left out. */
function frontmatterLines(field: FrontmatterField, value: string): string[] {
  if (field === 'tags') return [`tags: [${value.split(',').map(t => t.trim()).filter(Boolean).join(', ')}]`];
  if (field === 'thresholds') {
    const lines = value.split('\n').map(l => l.trim()).filter(l => l.includes(':') || l.startsWith('#'));
    return lines.length > 0 ? ['thresholds:', ...lines.map(l => `  ${l}`)] : ['thresholds: {}'];
  }
  const text = value || EMPTY_FIELD_DEFAULTS[field];
  return text ? [`${field}: ${text}`] : [];
}

/**
 * Whether rule markdown has detection logic: a detect block with a `match:` or `check:` expression, read the way
 * the rule pipeline reads it. Test Rule and detection run nothing else (not a `# Filter` section, a `metric:` or
 * the rule named by `extends:`), and a pipeline without either expression matches every row, so the rule would
 * trigger on any data.
 */
export function hasDetectionLogic(markdown: string): boolean {
  const lines: string[] = [];
  for (const line of DETECT_LOGIC_RE.exec(normalizeLineEndings(markdown))?.[2].split('\n') ?? []) {
    const text = line.trim();
    if (!text) continue;
    const last = lines.length - 1;
    // Like the pipeline, a line that ends with a backslash continues on the next one.
    if (last >= 0 && lines[last].endsWith('\\')) lines[last] = `${lines[last].slice(0, -1).trimEnd()} ${text}`;
    else lines.push(text);
  }
  let match = '';
  let check = '';
  for (const line of lines) {
    const colon = line.indexOf(':');
    const key = colon < 0 ? '' : line.slice(0, colon).trim().toLowerCase();
    if (key === 'match') match = line.slice(colon + 1).trim();
    else if (key === 'check') check = line.slice(colon + 1).trim();
  }
  return Boolean(match || check);
}

/**
 * Reads the form's fields from rule markdown. Without front matter, the front-matter fields are left out, so the
 * form keeps its own values for them.
 */
export function readRuleFields(markdown: string): Partial<RuleFormFields> {
  const { frontmatter, body } = splitFrontmatter(normalizeLineEndings(markdown));
  const sections = sectionBlocks(body);
  const text = (field: SectionField) => {
    const section = sections.find(block => block.key === SECTION_HEADINGS[field].toLowerCase());
    return section ? splitAtDetectBlock(section.lines.slice(1)).text.join('\n').trim() : '';
  };
  const fields: Partial<RuleFormFields> = {
    description: text('description'),
    whenTriggered: text('whenTriggered'),
    howToImprove: text('howToImprove'),
    examples: text('examples'),
    detect: DETECT_LOGIC_RE.exec(body)?.[2].trim() ?? '',
  };
  if (!frontmatter) return fields;
  const entry = (field: FrontmatterField): Block | undefined => {
    const at = lastBlockIndex(frontmatter, field);
    return at < 0 ? undefined : frontmatter[at];
  };
  const value = (field: FrontmatterField) => {
    const line = entry(field)?.lines[0] ?? '';
    // Like the rule parser, read a quoted value without its quotes.
    return line.slice(line.indexOf(':') + 1).trim().replaceAll(/^['"]|['"]$/g, '');
  };
  const thresholds = entry('thresholds')?.lines ?? [];
  return {
    ...fields,
    id: value('id'),
    name: value('name'),
    group: value('group'),
    severity: value('severity'),
    scope: value('scope'),
    version: value('version') || '1',
    tags: value('tags').replaceAll(/^\[|\]$/g, '').split(',').map(t => t.trim()).filter(Boolean).join(', '),
    thresholds: thresholds.slice(1, thresholds.length - trailingCount(thresholds, BLANK_OR_COMMENT))
      .filter(l => l.trim()).map(l => l.replace(/^ {2}/, '')).join('\n').trim(),
  };
}

/**
 * The lines of the `thresholds:` block that the rule parser uses, for Test Rule's threshold sliders: the block of
 * the last `thresholds:` key, which readRuleFields reads and mergeRuleMarkdown rewrites too, so an earlier block is
 * left out. `start` and `end` index the lines after the key in the markdown with LF line endings (see
 * normalizeLineEndings). Null when the markdown has no front matter or no `thresholds:` key.
 */
export function activeThresholdLines(markdown: string): { start: number; end: number } | null {
  const { frontmatter } = splitFrontmatter(normalizeLineEndings(markdown));
  const at = frontmatter ? lastBlockIndex(frontmatter, 'thresholds') : -1;
  if (!frontmatter || at < 0) return null;
  // Line 0 is the opening `---`, and a block's first line is its key.
  const key = 1 + frontmatter.slice(0, at).reduce((lines, block) => lines + block.lines.length, 0);
  return { start: key + 1, end: key + frontmatter[at].lines.length };
}

/**
 * Writes text sections into a rule body. The form edits the text before a detect block in a section, and keeps
 * the block and what follows it; it doesn't write a section whose heading is inside the detect block.
 */
function writeSections(body: string, fields: RuleFormFields, sectionFields: readonly SectionField[]): string {
  const blocks = sectionBlocks(body);
  const inDetectBlock = sectionsInDetectBlock(body, blocks);
  for (const field of sectionFields) {
    const heading = SECTION_HEADINGS[field];
    const content = (fields[field] || EMPTY_FIELD_DEFAULTS[field] || '').split('\n');
    const section = blocks.find(block => block.key === heading.toLowerCase());
    if (section && inDetectBlock.has(section)) continue;
    if (section) {
      const { text: old, rest } = splitAtDetectBlock(section.lines.slice(1));
      section.lines = rest.length > 0
        ? [section.lines[0], ...content, ...old.slice(old.length - trailingCount(old, BLANK, 0)), ...rest]
        : [section.lines[0], ...content, ''];
    } else {
      insertSection(blocks, { key: heading.toLowerCase(), lines: [`# ${heading}`, ...content, ''] });
    }
  }
  return joinBlocks(blocks);
}

/**
 * Writes the changed form fields into rule markdown and keeps everything else as it was: front-matter keys and
 * sections the form has no field for (such as `# Tests`), text around the detect block, and their order. Fields
 * the markdown doesn't have yet are added. Markdown without front matter gets every front-matter field from the
 * form, so it becomes a rule; from an empty `base`, this builds one. Empty fields get the template's defaults,
 * but only a `newRule` gets its detect logic: cleared detection logic stays cleared. A section whose heading is
 * inside the detect block is never written (see `sourceOnlyFields`).
 */
export function mergeRuleMarkdown(base: string, fields: RuleFormFields, changed: ReadonlySet<RuleFormField>, newRule = false): string {
  const md = normalizeLineEndings(base);
  const { frontmatter, body } = splitFrontmatter(md);
  let head = md.slice(0, md.length - body.length);
  const frontmatterFields = frontmatter ? FRONTMATTER_FIELDS.filter(field => changed.has(field)) : FRONTMATTER_FIELDS;
  if (frontmatterFields.length > 0) {
    const blocks = frontmatter ?? [];
    for (const field of frontmatterFields) {
      const lines = frontmatterLines(field, fields[field]);
      const at = lastBlockIndex(blocks, field);
      if (at < 0) {
        if (lines.length > 0) blocks.push({ key: field, lines });
      } else if (lines.length > 0) {
        const old = blocks[at].lines;
        blocks[at].lines = [...lines, ...old.slice(old.length - trailingCount(old, BLANK_OR_COMMENT))];
      } else {
        blocks.splice(at, 1);
      }
    }
    head = `---\n${joinBlocks(blocks)}\n---\n`;
  }
  const sectionFields = SECTION_FIELDS.filter(field => changed.has(field));
  let text = sectionFields.length > 0 ? writeSections(body, fields, sectionFields) : body;
  if (changed.has('detect')) text = writeDetectLogic(text, fields.detect || (newRule ? EMPTY_FIELD_DEFAULTS.detect ?? '' : ''));
  return head + text;
}
