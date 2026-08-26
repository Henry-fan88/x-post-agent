-- Optional starter memory. Run with `npm run db:seed:local`.
-- Kept out of migrations/ on purpose: it is a one-off you opt into, not schema.
-- Everything here is a guess the agent will overwrite as it learns from you --
-- the point is that the first draft isn't written by a stranger.

INSERT OR REPLACE INTO style_profile (user_id, handle, bio, profile_json) VALUES (
  'default',
  '',
  '',
  json('{
    "voice": "Plain, specific, and confident. Writes like a practitioner talking to peers, not a brand talking to a market.",
    "tone": ["direct", "curious", "concrete"],
    "do": [
      "Lead with the sharpest sentence -- no throat-clearing",
      "Use concrete numbers, names, and examples over abstractions",
      "Let a strong claim stand on its own without hedging it to death"
    ],
    "dont": [
      "No engagement bait (\"Thread 🧵\", \"Let that sink in\", \"Here is why:\")",
      "No LinkedIn cadence -- avoid one-line-paragraph stacking for drama",
      "No em dashes as a stylistic tic, no corporate filler",
      "Do not use hashtags"
    ],
    "emoji": "never",
    "hashtags": "never",
    "capitalization": "sentence",
    "max_chars": 280,
    "audience": "Builders, engineers, and people who follow AI and startups closely",
    "topics": ["AI", "software", "building products"],
    "signature_moves": [
      "Open with the conclusion, then earn it in one or two lines",
      "End on an observation rather than a call to action"
    ]
  }')
);

INSERT INTO preferences (user_id, rule, scope, weight, source) VALUES
  ('default', 'Never use hashtags.', 'global', 2.0, 'user'),
  ('default', 'Never open a thread with the word "Thread" or a 🧵 emoji.', 'format:insight_thread', 2.0, 'user'),
  ('default', 'Avoid em dashes; prefer a period or a comma.', 'global', 1.5, 'user'),
  ('default', 'Do not end posts with "What do you think?" or similar filler CTAs.', 'global', 1.5, 'user');
