const primitiveText = (value) => Object.values(value).filter((child) => (
  typeof child === 'string' || typeof child === 'number'
)).join(' ');

const deepValueForKeys = (value, keys) => {
  const stack = [value];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current)) {
      for (const key of keys) {
        if (current[key] !== undefined && current[key] !== null
          && String(current[key]).trim()) return current[key];
      }
    }
    const children = Array.isArray(current) ? current : Object.values(current);
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  return null;
};

const collectTmsTicketRecords = (value, orderNumber) => {
  const records = [];
  const stack = [value];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current) && primitiveText(current).includes(orderNumber)) records.push(current);
    const children = Array.isArray(current) ? current : Object.values(current);
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
  }
  return records;
};

export const findTmsTicketRecord = (value, orderNumber, { ticketNo = null } = {}) => {
  const records = collectTmsTicketRecords(value, String(orderNumber || '').trim());
  const normalizedTicketNo = String(ticketNo || '').trim();
  if (!normalizedTicketNo) return records[0] || null;
  return records.find((record) => String(deepValueForKeys(
    record,
    ['ticketNo', 'workOrderNo', 'orderNo'],
  ) || '').trim() === normalizedTicketNo) || null;
};

export const canRebindToVisibleTmsTicket = ({
  existingStatus,
  candidateCount,
  selectionStrategy,
  savedTicketId,
  savedTicketNo,
  visibleTicketId,
  visibleTicketNo,
} = {}) => {
  if (existingStatus !== 'matched'
    || Number(candidateCount) !== 1
    || selectionStrategy !== 'only-row'
    || !String(visibleTicketId || '').trim()
    || !String(visibleTicketNo || '').trim()) return false;
  return (String(savedTicketId || '').trim()
      && String(savedTicketId).trim() !== String(visibleTicketId).trim())
    || (String(savedTicketNo || '').trim()
      && String(savedTicketNo).trim() !== String(visibleTicketNo).trim());
};

export const hasConflictingTmsTicketIdentity = ({
  savedTicketId,
  savedTicketNo,
  visibleTicketId,
  visibleTicketNo,
} = {}) => {
  const savedNo = String(savedTicketNo || '').trim();
  const visibleNo = String(visibleTicketNo || '').trim();
  if (savedNo && visibleNo) return savedNo !== visibleNo;

  const savedId = String(savedTicketId || '').trim();
  const visibleId = String(visibleTicketId || '').trim();
  return Boolean(savedId && visibleId && savedId !== visibleId);
};
