// Guard public Playwright operations for all pages owned by one shop. Decorating
// returned locators/frames also covers adapters that do not use pacedAction.
export const installLoginActionBarrier = (context, beforeOperation) => {
  const seen = new WeakSet();
  const decorate = (object, page, kind = 'locator') => {
    if (!object || typeof object !== 'object' || seen.has(object)) return object;
    seen.add(object);
    const wrap = (name, mode = 'action', resultKind = 'locator') => {
      if (typeof object[name] !== 'function') return;
      const original = object[name];
      if (mode === 'factory') {
        object[name] = function (...args) {
          return decorate(Reflect.apply(original, this, args), page, resultKind);
        };
      } else if (mode === 'handles') {
        object[name] = async function (...args) {
          await beforeOperation(page, `${kind}.${name}`);
          const result = await Reflect.apply(original, this, args);
          return Array.isArray(result)
            ? result.map(value => decorate(value, page, resultKind))
            : decorate(result, page, resultKind);
        };
      } else {
        object[name] = async function (...args) {
          await beforeOperation(page, `${kind}.${name}`);
          return Reflect.apply(original, this, args);
        };
      }
    };
    // evaluate/evalOnSelector may perform DOM mutations even in read helpers.
    for (const name of [
      'click', 'dblclick', 'tap', 'hover', 'fill', 'clear', 'press', 'type',
      'pressSequentially', 'check', 'uncheck', 'setChecked', 'selectOption',
      'setInputFiles', 'focus', 'blur', 'dispatchEvent', 'dragTo', 'dragAndDrop',
      'scrollIntoViewIfNeeded', 'evaluate', 'evaluateAll', '$eval', '$$eval',
      'goto', 'reload', 'goBack', 'goForward', 'setContent', 'bringToFront',
      'close', 'addScriptTag', 'addStyleTag', 'screenshot', 'setViewportSize',
    ]) wrap(name);
    for (const name of [
      'locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder',
      'getByAltText', 'getByTitle', 'getByTestId', 'first', 'last', 'nth',
      'filter', 'and', 'or', 'frameLocator', 'owner',
    ]) wrap(name, 'factory');
    for (const name of ['$', '$$', 'elementHandle', 'elementHandles', 'evaluateHandle']) {
      wrap(name, 'handles', 'handle');
    }
    if (kind === 'handle') wrap('contentFrame', 'handles', 'frame');
    if (kind === 'locator') {
      wrap('contentFrame', 'factory', 'frame');
      wrap('all', 'handles', 'locator');
    }
    if (kind === 'page') {
      wrap('mainFrame', 'factory', 'frame');
      wrap('frame', 'factory', 'frame');
      const frames = object.frames;
      object.frames = function (...args) {
        return Reflect.apply(frames, this, args).map(frame => decorate(frame, page, 'frame'));
      };
      for (const [device, methods] of [
        [object.mouse, ['click', 'dblclick', 'move', 'down', 'up', 'wheel']],
        [object.keyboard, ['down', 'up', 'press', 'type', 'insertText']],
        [object.touchscreen, ['tap']],
      ]) {
        if (!device) continue;
        for (const name of methods) {
          if (typeof device[name] !== 'function') continue;
          const original = device[name];
          device[name] = async function (...args) {
            await beforeOperation(page, `${kind}.${name}`);
            return Reflect.apply(original, this, args);
          };
        }
      }
      for (const frame of object.frames()) decorate(frame, page, 'frame');
      object.on('frameattached', frame => decorate(frame, page, 'frame'));
    }
    return object;
  };
  const attach = page => decorate(page, page, 'page');
  for (const page of context.pages()) attach(page);
  context.on('page', attach);
  const newPage = context.newPage;
  context.newPage = async function (...args) {
    await beforeOperation(null, 'context.newPage');
    const page = attach(await Reflect.apply(newPage, this, args));
    return page;
  };
  return { attach, ready: Promise.resolve() };
};
