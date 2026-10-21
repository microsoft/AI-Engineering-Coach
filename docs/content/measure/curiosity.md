---
title: "Curiosity"
weight: 40
description: "Sessions with inquiry, inquiry over time, and investigation sources"
---

# Curiosity

Curiosity shows which sessions contain inquiry, where investigation occurs, and
how inquiry changes over time. Use it to reflect on how you balance asking AI to
carry out tasks with asking questions to understand what you are building.
Seeking explanations and checking your understanding can help you stay involved
in the work, review decisions, and spot mistakes.

The page only observes recorded conversation activity. It does not measure
understanding, retention, or productivity. Task execution can involve thoughtful
work too; a low Explore share does not prove disengagement or lost understanding.
Select **What does Curiosity show?** beneath the title for a short explanation.
Select it again, click outside, or press Escape to close it.

Workspace, harness, date, and language filters apply to all counts and
evidence. Hover or focus a bar, source, language row, or count to see recent
sampled prompts. In an inspected session row, select **Open in Timeline** to open its day on the
[Timeline](../observe/timeline.md).

Prompts appear in bold foreground text. A shortened preview ends in **...**;
select that **prompt text** to open a compact reader directly beneath it. Complete
prompts that fit within the 80-character preview limit are not expandable.
The shortened preview and reader show the same sampled turn, not the first
message used as the session name. Long prompts scroll inside
the reader, and the preview stays open while you read. This works for chart bars,
counts, activity labels, sources, and language rows. Focus a preview trigger and
press Arrow Down to focus its first expandable prompt; Enter or Space expands it. Select the
prompt text again to collapse the reader. Escape dismisses a preview or collapses
an inspected row's reader.

Prompt text loads locally only when expanded. If the matching turn is unavailable,
the reader says so; it never substitutes the session's first prompt. Some
harnesses or large messages only provide a truncated stored preview, which is
marked explicitly.

Session previews can show up to four **recorded context** tags: two web hosts
from explicit URLs given to web tools, and two repository path areas. The number
on a tag is the count of human turns with that context. Tags do not use prompt
keywords or guessed topics.

## Sessions with inquiry

**Sessions with inquiry** counts sessions with at least one unique, classified
inquiry turn. The denominator is all sessions with unique human turns in the
selection. The summary also shows inquiry-only sessions, mixed sessions,
inquiry turns, and follow-up sequences.

Each count has **WoW** and **MoM** badges. WoW compares the latest 7 days with
the 7 days before them. MoM compares the latest 28 days with the 28 days before
them. Both windows end on the selected end date, or today. **New** means that
the previous window had activity but a zero count. **--** means that the
previous window had no human activity. A change is not a health signal.

## Activity balance

Each classified human turn counts once, even if it contains many questions.

| Activity | Required recorded evidence |
| --- | --- |
| **Model knowledge inquiry** | An answered question without research or action tools. |
| **Web-grounded inquiry** | An answered question with web research, without repository reads or project actions. |
| **Program comprehension** | An answered question with repository reads, without project actions. |
| **Task execution** | Edited files, write tools, or terminal tools, including PowerShell. A question is not necessary. |

Actions take precedence over inquiry. Repository reads take precedence over web
research. For example, "Can you fix the parser?" is **Task execution** when it causes a
write or a command.

Question detection uses the native `sentences().isQuestion()` function of
Compromise. Tool classification uses exact tool names. The page does not use
keyword lists, topic classifiers, or model calls.

**Explore** is the sum of the three inquiry categories. **Inquiry share** is
Explore turns divided by all classified turns. The chart shows inquiry counts
(or all turns) and an **Explore share** curve on a fixed 0-100% scale. The
chart interval is daily for up to 14 days, weekly for 15 to 90 days, and
monthly for longer ranges. Select a bar to see the sessions of that period.
The selected **Explore** or **All turns** view stays selected when date, language,
workspace, or harness filters change. Task execution is not a catch-all for other
prompts: turns without sufficient recorded evidence remain unclassified.

## How your answers were grounded

This section counts information sources. The counts overlap with each other and
with the activity categories.

| Source evidence | What counts |
| --- | --- |
| **Web sources** | Web search or fetch tools. |
| **Repository reads** | File read or code search tools. |
| **Investigation agents** | A delegation tool with an explicit `research` or `explore` role. |

Each source counts once for each human turn and once for each session. A turn
with web research and a file edit is **Task execution**, but its web source still shows
here. A recorded tool request does not prove that the tool succeeded.

## Programming-language context

Language rows use the file extensions in the recorded file reads, references,
and edits of each session. A session that touches TypeScript and Python files
shows in both rows, so the rows are not additive. Sessions do not inherit
languages from their project. Configuration and documentation files do not set
a language. `.tsx` counts as TypeScript and `.jsx` counts as JavaScript.

Select a language row to filter the page. Select it again, or select **Clear**,
to remove the filter.

## Follow-up inquiry sequences

A follow-up sequence is two or more consecutive answered question turns in the
same session, not more than 24 hours apart. Project actions, unknown tools,
canceled or unanswered turns, and AI `ask_user` gates break a sequence.
Sequences with three or more turns have a separate count. The preview can show
the elapsed time of a sequence. This time includes response time and pauses,
and it is not a measure of attention.

## Copied histories and repeated wording

Native event IDs and timestamps identify copied events, so a copied turn counts
one time. Text similarity is not used to remove duplicates.

**Repeated inquiry wording** finds the same normalized question in different
sessions. A question must have at least five words and fewer than 240
characters. The cleaned message must be 500 characters or less. The page keeps
up to three questions for each message and shows up to eight groups. A repeated
question does not prove that the user forgot the answer.
Inline identifiers stay distinct: questions about `Map` and `Set` are not the
same repeated wording merely because both identifiers are formatted as code.

## Coverage and limits

Turns without enough evidence are **unclassified**. They are not in the
inquiry-share denominator. Answer evidence comes from final answer messages or
from successful task completion events. Older logs can supply weaker answer
evidence.

English grammar detection can miss questions without punctuation or with
spelling errors. Other languages, pasted code without fences, and incomplete
logs can also change the results.

## Curiosity anti-pattern checks

Curiosity findings show in **Anti-Patterns > Prompt Quality**. The
**Curiosity checks** link on the page opens this group.

| Level | Meaning | Anti-pattern |
| --- | --- | --- |
| **Balanced** | Inquiry share is 10-50%, and no inquiry type is more than 80%. | No finding. |
| **Needs review** | Inquiry share is outside 10-50%, or one inquiry type is more than 80%. | Medium **Curiosity balance** finding. |
| **Strongly skewed** | Inquiry share is less than 5% or more than 95%, or one inquiry type is more than 95%. | High **Curiosity balance** finding. |

A check needs at least 50 classified turns, 7 active dates, and 70%
classification coverage. The inquiry-type check also needs 20 inquiry turns.
If there is not sufficient evidence, the page shows **More evidence needed**
and does not grade the balance. **Repeated inquiry wording** is a separate
low-severity finding.

The checks use the Prompt Quality weights: low is 3, medium is 7, and high is
12 penalty units. Weekly trends apply the same checks to each week. All ranges
are product defaults, not validated health standards.

## Research basis

Research on cognitive offloading and active engagement motivates reflection,
not a diagnosis based on a question count or ratio:

- [Lee et al. (2025)](https://doi.org/10.1145/3706598.3713778) surveyed 319
  knowledge workers, collecting 936 examples of GenAI use. Higher confidence in
  GenAI was associated with less self-reported critical thinking, and the nature
  of critical thinking shifted toward verification, integration, and task
  stewardship. This is self-reported association, not causal evidence of
  developers losing skills over time.
- [Shen and Tamkin (2026)](https://arxiv.org/abs/2601.20245) ran a randomized
  study with 52 mostly junior developers learning an unfamiliar Python library.
  AI-assisted participants showed lower immediate mastery on average.
  Explanation-seeking and conceptual-inquiry interaction patterns were associated
  with stronger comprehension, but those patterns were not randomized. The
  study is small and task-specific; it does not establish long-term effects.

Neither study validates Curiosity's classifier, an individual learning score,
or the dashboard's default inquiry-share thresholds. The current classifier
observes answered grammatical questions and recorded tools, not intent: for
example, an instruction to "Explain the parser" need not count as a question.

The research below also supports exact denominators, source evidence, and
temporal order. It does not validate this dashboard or its classifier.

- [Matcha et al. (2020)](https://doi.org/10.1109/TLT.2019.2916802): learning
  dashboards often have weak theory. The page shows evidence, not a learning
  score.
- [Xia et al. (2018)](https://doi.org/10.1109/TSE.2017.2734091): developers
  use approximately 58% of their time on program comprehension. The page shows
  repository investigation beside project action.
- [Graesser and Person (1994)](https://doi.org/10.3102/00028312031001104):
  more questions do not mean better results. The page has no target count.
- [Molenaar and Jarvela (2014)](https://doi.org/10.1007/s11409-014-9114-2):
  sequence and timing are important in self-regulated learning. The page counts
  follow-ups, but does not infer learning.
- [Information seeking with AI assistants (2024)](https://arxiv.org/html/2408.04032v2):
  developers use different information sources. The page keeps direct
  questions, web research, and repository reads separate.

## Local processing

The parse worker analyzes English text with the MIT-licensed `compromise`
library. Analysis does not use telemetry, model downloads, or network calls,
and it does not change session logs.

Before analysis, the parser removes fenced code, quoted text, URLs, and
harness context blocks (tags in `snake_case` or `kebab-case`). A replayed
transcript with `User:` and `Assistant:` labels counts only its latest user
turn. Turns that a harness marks as agent, system, sidechain, compaction
summary, or relayed from another session (a `from_*` sender field) are not
human turns. Harness prompts without such markers count as human turns.
Inline code identifiers inside prose questions are retained; standalone code
and quoted or code-formatted questions are still excluded.

The parser does not scan inputs of more than 256,000 characters, more than 256
sentence lines, or more than 32,000 characters in one line. Question excerpts
have a limit of 240 characters. Previews show web hosts only. They do not show
home paths, URL credentials, URL paths, or query parameters.
