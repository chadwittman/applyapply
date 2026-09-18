# Chrome Web Store submission

## Listing copy

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

## Permission justifications

| Permission | Justification |
| --- | --- |
| `activeTab` | Lets the user explicitly open applyapply on the current job page from the toolbar. |
| `storage` | Stores the signed-in session and extension preferences. |
| `clipboardWrite` | Supports the user-requested copy action for application answers. |
| `scripting` | Injects the applyapply panel and form-filling behavior after the user opens it. |
| `offscreen` | Provides optional voice transcription for an application answer after the user starts it. |
| Named ATS host permissions | Automatically recognizes and assists supported job-board application pages. |
| Optional `*://*/*` host permission | Enables auto-detection on other job sites only after the user explicitly grants it in the popup. Without it, the toolbar action still works through `activeTab`. |

## Privacy answers

The extension handles personally identifiable information, authentication information, user-generated content, website content, and form data. It sends only the data needed for the requested feature to applyapply's server and its disclosed providers. It does not sell data, use it for advertising, or transfer it for unrelated purposes.
