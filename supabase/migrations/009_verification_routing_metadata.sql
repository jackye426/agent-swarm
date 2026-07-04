-- Routing metadata produced by the verification cell.

alter table verification_records
  add column if not exists failure_owner text,
  add column if not exists failed_ac_ids text[] not null default '{}',
  add column if not exists failure_summary text,
  add column if not exists recommended_next_step text,
  add column if not exists question_for_user text;

alter table verification_records
  drop constraint if exists verification_records_failure_owner_check;

alter table verification_records
  add constraint verification_records_failure_owner_check
  check (
    failure_owner is null or
    failure_owner in (
      'implementation',
      'contract',
      'human_decision',
      'infrastructure',
      'unknown'
    )
  );
