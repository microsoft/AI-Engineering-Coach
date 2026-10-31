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
/** A whole detect block, which the form keeps out of the text sections. */
const DETECT_BLOCK_RE = /```detect[\s\S]*?```/g;
/** The logic of the first detect block, found the way the rule parser finds it. */
const DETECT_LOGIC_RE = /(```detect\s*\n)([\s\S]*?)(```)/;

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
    if (last?.key && /^(\s|$)/.test(line)) last.lines.push(line);
    else blocks.push({ key: /^(\w[\w-]*):/.exec(line)?.[1] ?? '', lines: [line] });
  }
  return blocks;
}

/** Splits a rule body at headings outside code fences. The first block holds any text before the first heading. */
function sectionBlocks(body: string): Block[] {
  const blocks: Block[] = [{ key: '', lines: [] }];
  let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const heading = inFence ? null : /^#+\s+(.+?)\s*$/.exec(line);
    if (heading) blocks.push({ key: heading[1].toLowerCase(), lines: [line] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks;
}

function joinBlocks(blocks: Block[]): string {
  return blocks.flatMap(block => block.lines).join('\n');
}

function trailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 1 && !lines[end - 1].trim()) end--;
  return lines.slice(end);
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

function writeDetectLogic(body: string, logic: string): string {
  if (DETECT_LOGIC_RE.test(body)) {
    return body.replace(DETECT_LOGIC_RE, (_block, open: string, _logic: string, close: string) => `${open}${logic}\n${close}`);
  }
  const blocks = sectionBlocks(body);
  const fence = ['```detect', ...logic.split('\n'), '```'];
  const section = blocks.find(block => block.key === 'detection logic');
  if (section) section.lines.splice(section.lines.length - trailingBlankLines(section.lines).length, 0, ...fence);
  else insertSection(blocks, { key: 'detection logic', lines: ['# Detection Logic', ...fence, ''] });
  return joinBlocks(blocks);
}

/** The front-matter lines the form writes for a field. A field with no value and no default is left out. */
function frontmatterLines(field: FrontmatterField, value: string): string[] {
  if (field === 'tags') return [`tags: [${value.split(',').map(t => t.trim()).filter(Boolean).join(', ')}]`];
  if (field === 'thresholds') {
    const lines = value.split('\n').map(l => l.trim()).filter(l => l.includes(':'));
    return lines.length > 0 ? ['thresholds:', ...lines.map(l => `  ${l}`)] : ['thresholds: {}'];
  }
  const text = value || EMPTY_FIELD_DEFAULTS[field];
  return text ? [`${field}: ${text}`] : [];
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
    return section ? section.lines.slice(1).join('\n').replaceAll(DETECT_BLOCK_RE, '').trim() : '';
  };
  const fields: Partial<RuleFormFields> = {
    description: text('description'),
    whenTriggered: text('whenTriggered'),
    howToImprove: text('howToImprove'),
    examples: text('examples'),
    detect: DETECT_LOGIC_RE.exec(body)?.[2].trim() ?? '',
  };
  if (!frontmatter) return fields;
  const entry = (field: FrontmatterField) => frontmatter.find(block => block.key === field);
  const value = (field: FrontmatterField) => {
    const line = entry(field)?.lines[0] ?? '';
    return line.slice(line.indexOf(':') + 1).trim();
  };
  return {
    ...fields,
    id: value('id'),
    name: value('name'),
    group: value('group'),
    severity: value('severity'),
    scope: value('scope'),
    version: value('version') || '1',
    tags: value('tags').replaceAll(/^\[|\]$/g, '').split(',').map(t => t.trim()).filter(Boolean).join(', '),
    thresholds: (entry('thresholds')?.lines.slice(1) ?? []).filter(l => l.trim()).map(l => l.replace(/^ {2}/, '')).join('\n').trim(),
  };
}

/**
 * Writes the changed form fields into rule markdown and keeps everything else as it was: front-matter keys and
 * sections the form has no field for (such as `# Tests`), text around the detect block, and their order. Fields
 * the markdown doesn't have yet are added. Markdown without front matter gets every front-matter field from the
 * form, so it becomes a rule; from an empty `base`, this builds a new rule.
 */
export function mergeRuleMarkdown(base: string, fields: RuleFormFields, changed: ReadonlySet<RuleFormField>): string {
  const md = normalizeLineEndings(base);
  const { frontmatter, body } = splitFrontmatter(md);
  let head = md.slice(0, md.length - body.length);
  const frontmatterFields = frontmatter ? FRONTMATTER_FIELDS.filter(field => changed.has(field)) : FRONTMATTER_FIELDS;
  if (frontmatterFields.length > 0) {
    const blocks = frontmatter ?? [];
    for (const field of frontmatterFields) {
      const lines = frontmatterLines(field, fields[field]);
      const at = blocks.findIndex(block => block.key === field);
      if (at < 0) {
        if (lines.length > 0) blocks.push({ key: field, lines });
      } else if (lines.length > 0) {
        blocks[at].lines = [...lines, ...trailingBlankLines(blocks[at].lines)];
      } else {
        blocks.splice(at, 1);
      }
    }
    head = `---\n${joinBlocks(blocks)}\n---\n`;
  }
  let text = body;
  const sectionFields = SECTION_FIELDS.filter(field => changed.has(field));
  if (sectionFields.length > 0) {
    const blocks = sectionBlocks(body);
    for (const field of sectionFields) {
      const heading = SECTION_HEADINGS[field];
      const content = (fields[field] || EMPTY_FIELD_DEFAULTS[field] || '').split('\n');
      const section = blocks.find(block => block.key === heading.toLowerCase());
      if (section) {
        // A detect block inside a text section belongs to the Detection Logic field, so it stays.
        const detectBlocks = section.lines.slice(1).join('\n').match(DETECT_BLOCK_RE) ?? [];
        section.lines = [section.lines[0], ...content, '', ...detectBlocks.flatMap(block => [...block.split('\n'), ''])];
      } else {
        insertSection(blocks, { key: heading.toLowerCase(), lines: [`# ${heading}`, ...content, ''] });
      }
    }
    text = joinBlocks(blocks);
  }
  if (changed.has('detect')) text = writeDetectLogic(text, fields.detect || EMPTY_FIELD_DEFAULTS.detect || '');
  return head + text;
}
