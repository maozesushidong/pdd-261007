\encoding UTF8
\pset format unaligned
\pset tuples_only on

SELECT concat_ws('|',
  'state', status, runtime_status, current_step,
  coalesce(manual_review_reason, ''))
FROM work_orders
WHERE id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid;

SELECT concat_ws('|',
  'saved',
  coalesce(payload#>>'{tmsWorkOrder,ticketId}', ''),
  coalesce(payload#>>'{tmsWorkOrder,ticketNo}', ''),
  coalesce(payload#>>'{tmsWorkOrder,effectStage}', ''),
  coalesce(payload#>>'{tmsWorkOrder,recoverySource}', ''))
FROM work_orders
WHERE id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid;

SELECT concat_ws('|',
  'observed',
  coalesce(payload#>>'{tmsDuplicateCheck,status}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,reason}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,candidateCount}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,selectionStrategy}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,ticketId}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,ticketNo}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,identity,attrValue}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,identity,tracking}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,identity,warehouse}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,identity,carrier}', ''))
FROM work_orders
WHERE id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid;

SELECT concat_ws('|',
  'identity-text',
  coalesce(payload#>>'{tmsDuplicateCheck,identity,text}', ''))
FROM work_orders
WHERE id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid;

SELECT concat_ws('|',
  'decision',
  coalesce(payload#>>'{tmsDuplicateCheck,decisionComparison,required}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,decisionComparison,matches}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,decisionComparison,expectedProblemType}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,decisionComparison,actualProblemType}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,decisionComparison,expectedCustomerRemark}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,decisionComparison,actualCustomerRemark}', ''))
FROM work_orders
WHERE id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid;

SELECT concat_ws('|',
  'suborder',
  coalesce(payload#>>'{tmsDuplicateCheck,suborderComparison,provablyDifferent}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,suborderComparison,sameTrade}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,suborderComparison,expectedOmsOrder}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,suborderComparison,existingOmsOrder}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,suborderComparison,expectedTracking}', ''),
  coalesce(payload#>>'{tmsDuplicateCheck,suborderComparison,existingTracking}', ''))
FROM work_orders
WHERE id = '5b021581-2345-48e4-bf08-00b68a0ee6e8'::uuid;
