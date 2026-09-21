# Chrome Web Store submission

## Listing copy

**Store title**

applyapply — AI job applications

**Category**

Productivity

**Language**

English

**Website / official URL**

https://applyapply.xyz

**Support email**

wittman.c@gmail.com

**Privacy policy URL**

https://applyapply.xyz/privacy

**Short description**

Tailored job applications, filled faster. Find roles overnight, generate an apply kit, and review before you submit.

**Detailed description**

applyapply helps you move from job search to finished application without retyping your story into every form.

Agents find roles that match your saved profile. For each role, applyapply can prepare a tailored resume, cover note, and answers to application questions. The Chrome extension puts that work beside the application form so you can review it, fill fields, and submit yourself.

You stay in control: applyapply does not submit applications for you. Your profile, resume, and generated materials are used only to provide the job-application workflow.

Features:
- Overnight job sourcing based on your target roles
- Tailored resumes and cover notes for each role
- Saved answers that improve as you review applications
- One-click form filling on supported job boards
- Optional keyboard shortcut: Alt+Enter on Windows/Linux or Option+Return on Mac to fill the focused field and advance
- Works with Chrome, Edge, Brave, and Arc

Support: wittman.c@gmail.com
Privacy: https://applyapply.xyz/privacy

## Image checklist

Google's current listing guidance calls for:

- Store icon: `128x128` PNG (already in `extension/icons/icon-128.png`)
- At least one screenshot, up to five: `1280x800` PNG/JPEG (640x400 is also accepted)
- Small promo tile: `440x280` PNG/JPEG
- Optional marquee tile: `1400x560` PNG/JPEG

Prepared assets:

- `store-assets/applyapply-small-promo.png`
- `store-assets/applyapply-marquee.png`
- `store-assets/screenshot-1-kit.png` through `screenshot-5-popup.png` (1280x800, invented candidate and company). Regenerate with `AA_TEST_SUITES=tools/store-screenshots.mjs npm test`.

Recommended screenshot sequence:

1. A supported job page with the applyapply sidebar open and the tailored kit visible.
2. The tailored resume panel with the download action visible.
3. The Q&A section showing reviewable, editable answers and copy controls.
4. A form with applyapply field controls visible, demonstrating fill-and-advance.
5. The extension popup showing sign-in, credits, and profile settings.

Use real product screenshots, square corners, full bleed, and minimal overlay text. Do not show real email addresses, private resumes, API keys, or payment details.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | Lets the user explicitly open applyapply on the current job page from the toolbar. |
| `storage` | Stores the signed-in session and extension preferences. |
| `clipboardWrite` | Supports the user-requested copy action for application answers. |
| `scripting` | Injects the applyapply panel and form-filling behavior after the user opens it. |
| `offscreen` | Provides optional voice transcription for an application answer after the user starts it. |
| Named ATS host permissions | When the user clicks the toolbar button, lets applyapply run inside application forms these platforms embed on company career sites (cross-origin iframes that activeTab does not cover), and lets the extension talk to its own server at applyapply.xyz. Nothing runs on page load. |

## Privacy answers

The extension handles personally identifiable information, authentication information, user-generated content, website content, and form data. It sends only the data needed for the requested feature to applyapply's server and its disclosed providers. It does not sell data, use it for advertising, or transfer it for unrelated purposes.
