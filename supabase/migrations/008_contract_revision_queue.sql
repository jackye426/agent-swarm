-- Queue used when verification finds a contract/planning defect.

select pgmq.create('task_contract_revision_requested');
