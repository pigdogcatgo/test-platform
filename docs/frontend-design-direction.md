# Practice folio frontend direction

Design owner: Designer. Reviewed against root `DESIGN.md`, the frontend design skill, existing `App.jsx`, `index.css`, and teacher/student reviewer feedback.

## Figma reference

[Editable teacher desktop and student mobile concepts](https://www.figma.com/design/8ivNi3jOb42T2YL6KznDM7?node-id=2-132).

The file contains semantic editable frames/text and three Simple Design System button instances, not screenshots. Composition has 61 descendants: 21 frames, 37 text nodes and three instances. Inter is asserted throughout; there are no image fills. Blue/100 and Blue/700 library variables bind the canvas and primary actions. A composition screenshot was inspected, sizing defects corrected, and the final desktop/mobile composition inspected.

This is a design direction, not a claim that the sample data or every Figma arrangement matches the implemented application. The teacher concept displays a populated assignment plus an empty-state example together to document both states. Production shows the applicable state only. Names/counts in Figma are fictional.

## Identity and deliberate risk

Use a mathematical practice folio: soft blue paper, white work surfaces, dark blue ink, a restrained folio margin, and an oversized functional assignment/question count. The count gives the distinctive element a purpose. A static geometry drawing on authentication can extend the same identity. Keep motion and ornament out of timed test tasks.

Retain the existing Inter/system font stack. Use 32–40px main headings, 20–24px section headings, 16px body, and 14px helper text. Keep 8px spacing increments, 12–16px surface corners, thin blue borders, and little elevation.

Recommended palette:

| Role | Value |
| --- | --- |
| Canvas | `#F1F6FD` |
| Surface | `#FFFFFF` |
| Quiet feature surface | `#E6EFFB` |
| Action/link | `#2A61BA` |
| Hover | `#20529F` |
| Main ink | `#183451` |
| Secondary ink | `#526780` |
| Border | `#D4E2F2` |
| Folio margin | `#C1D4ED` |

Existing `#006DA6` action color is an acceptable compatibility choice where it already carries consistent behavior. Large surfaces should remain soft blue or white. Danger, warning, success and timer urgency retain semantic colors and explicit labels.

## Screen contract

Teacher dashboard: shared brand/header and sign out; task-specific folio introduction with actual test count; Create test as primary action; Register students and Problem bank as secondary; tests and student roster; class ELO privacy setting after the core work. Empty test state includes a Create test action. Preserve privacy help, checkbox and loading/error/saving states.

Student dashboard: shared header; compact greeting and actual available assignment count; available tests first; history second; progress/ELO below. Each assignment retains format, question count, duration, preparation state, expiry state, and the production auto-submit warning before Start test. ELO remains explicitly described as an estimate, not a grade. Anonymous average suppression and answer release behavior remain unchanged.

Timed test: preserve sticky timer, question navigation, answer saving, review and submit. Carry the folio identity through static borders and readable numbering only. On mobile, selecting a PDF question should reveal its answer panel before focusing its answer input. PDF sections require a real heading target for `aria-labelledby`.

Authentication: light blue branded panel with static mathematical geometry, clear sign-in form on white, errors adjacent to the form, useful password controls, and a single-column compact layout on phones.

Other teacher/admin pages: apply shared semantic palette, action hierarchy, surfaces and header conventions while preserving existing data contracts, rights review, AI consent, approval controls, and disclosure copy.

## Responsive and accessibility acceptance

- Use one column below content-driven tablet breakpoints; keep actions wrapping naturally.
- Let headings and helper text grow; do not impose fixed text heights.
- At 320–390px widths, keep headers, cards, inputs and action rows inside the viewport.
- Use real headings/landmarks and labels, visible keyboard focus, and at least 44px primary button height.
- Preserve production tab-switch warning and existing color-independent status labels.
- Use meaningful loading, empty and error states; do not substitute invented statistics.
- Validate desktop and mobile rendered pages after implementation. A reviewed Figma composition alone does not verify the application.
