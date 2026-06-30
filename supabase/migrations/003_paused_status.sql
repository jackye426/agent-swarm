-- TaskGraph OS — migration 003
-- Add 'paused' to agent_run_status enum.
-- Used when a planning run hits interrupt() and suspends pending human escalation.
-- Reserved for future Telegram/notification escalation path; not active yet.

alter type agent_run_status add value if not exists 'paused';
