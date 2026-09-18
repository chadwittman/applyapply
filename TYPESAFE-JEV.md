# Jev sourcing review

Jev is wired as an opt-in review step after a listing is fetched and before it is added to a user's pipeline.

Enable locally with:

```env
TYPESAFE_API_KEY=ts_...
JAA_JEV=1
```

For each candidate listing, Jev returns two typed judgments:

- A three-level fit score based on the user's target roles, location preference, and the listing text. A high-confidence result can update the existing 0-10 fit score to 4, 7, or 9.
- A prompt-injection probability. Listings at or above 0.75 are excluded from the pipeline and recorded as `prompt_injection` rather than being passed to generation.

The default is off. The normal sourcing path, credit reservation, Hyperbrowser usage, and Claude generation are unchanged until the feature is explicitly enabled. Candidate profile data sent to Jev is limited to target roles, location, and location preference; contact details and resume text are not sent.

The first live smoke test returned typed answers from `jev-1.13.0` for role family, remote eligibility, and fit. Before enabling this for users, compare Jev's fit judgments with existing sourcing results over a representative sample and confirm current TypeSafe pricing.
