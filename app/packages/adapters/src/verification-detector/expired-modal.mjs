// A rendered terminal error is different from a still-solvable challenge.
// No elapsed-time rule is used here, and no browser/page fallback is allowed.
const findExpiredVerificationModalCandidateInternal = async (frame, {
  allowLiveControls = false,
  patternSource = '验证(?:时间过长|(?:码)?已(?:过期|失效)|已超时)[，,、。\\s]*(?:请(?:重新验证|重试|刷新后重试))?',
} = {}) => frame.evaluate(({ allowLiveControls: allowControls, pattern }) => {
  const expired = new RegExp(pattern, 'u');
  if(!expired.test(String(document.body?.innerText||'')))return null;
  const activeInstruction = /请点击|请向右滑|拖动.*滑块|完成拼图|请输入.*验证码/u;
  const challengeSelector = '[class*="captcha" i],[id*="captcha" i],[data-testid*="captcha" i],[class*="verify" i],[data-testid*="verify" i]';
  const closeSelector = '[data-testid="beast-core-modal-close-button"],[aria-label="关闭"],[title="关闭"],[aria-label="Close"],[title="Close"],[class*="close" i],[id*="close" i]';
  const visible = element => {
    if(!element.checkVisibility({opacityProperty:true,visibilityProperty:true}))return false;
    const r=element.getBoundingClientRect(),s=getComputedStyle(element);
    return r.width>4&&r.height>4&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight
      &&s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity||1)>0;
  };
  const roots=[document];
  for(let i=0;i<roots.length;i++)for(const node of roots[i].querySelectorAll('*'))if(node.shadowRoot)roots.push(node.shadowRoot);
  const nodes=roots.flatMap(root=>[...root.querySelectorAll('*')])
    .filter(node=>visible(node)&&expired.test(String(node.innerText||''))
      &&![...node.children].some(child=>expired.test(String(child.innerText||''))))
    .sort((a,b)=>String(a.innerText||'').length-String(b.innerText||'').length);
  for(const node of nodes){
    for(let surface=node,depth=0;surface&&depth<10;surface=surface.parentElement,depth++){
      if(surface===document.body||surface===document.documentElement)break;
      const rect=surface.getBoundingClientRect();
      if(!visible(surface)||rect.width<200||rect.width>800||rect.height<100||rect.height>600)continue;
      if(!surface.matches(challengeSelector)&&!surface.querySelector(challengeSelector))continue;
      const text=String(surface.innerText||'');
      if(!expired.test(text)||activeInstruction.test(text))continue;
      const liveControls=[...surface.querySelectorAll('[role="slider"],[draggable="true"],input,input[type="range"],iframe')];
      if(!allowControls&&liveControls.some(visible))continue;
      const closes=[...surface.querySelectorAll(closeSelector)].filter(visible).map(element=>({element,rect:element.getBoundingClientRect()}))
        .filter(({rect:r})=>r.width>=12&&r.width<=72&&r.height>=12&&r.height<=72
          &&Math.abs(r.x+r.width/2-rect.right)<=64&&Math.abs(r.y+r.height/2-rect.top)<=64)
        .sort((a,b)=>Math.abs(a.rect.x+a.rect.width/2-rect.right)+Math.abs(a.rect.y+a.rect.height/2-rect.top)
          -Math.abs(b.rect.x+b.rect.width/2-rect.right)-Math.abs(b.rect.y+b.rect.height/2-rect.top));
      const anonymousCloses=[...surface.querySelectorAll('*')].filter(visible).map(element=>({element,rect:element.getBoundingClientRect()}))
        .filter(({rect:r})=>r.width>=12&&r.width<=72&&r.height>=12&&r.height<=72
          &&Math.abs(r.x+r.width/2-rect.right)<=64&&Math.abs(r.y+r.height/2-rect.top)<=64)
        .filter(({element})=>{
          const style=getComputedStyle(element);
          const metadata=[element.innerText,element.getAttribute('aria-label'),element.getAttribute('title'),
            element.id,element.className].filter(Boolean).join(' ');
          return /(?:关闭|close|×)/iu.test(metadata)
            || ['button','svg','path'].includes(String(element.tagName||'').toLowerCase())
            || element.getAttribute('role')==='button'
            || style.cursor==='pointer'
            || style.borderRadius==='50%';
        })
        .sort((a,b)=>Math.abs(a.rect.x+a.rect.width/2-rect.right)+Math.abs(a.rect.y+a.rect.height/2-rect.top)
          -Math.abs(b.rect.x+b.rect.width/2-rect.right)-Math.abs(b.rect.y+b.rect.height/2-rect.top));
      const close=closes[0]||anonymousCloses[0];
      if(!close)continue;
      const box=r=>({x:r.x,y:r.y,width:r.width,height:r.height});
      return {reason:'expired-verification-modal',confidence:'high',selector:challengeSelector,
        boundingBox:box(rect),closeSelector,closeBoundingBox:box(close.rect),
        closeMethod:closes.length?'element':'coordinate',terminalText:text.match(expired)[0]};
    }
  }
  return null;
}, { allowLiveControls, pattern: patternSource }).catch(()=>null);

export const findExpiredVerificationModalCandidate = async (frame) => (
  findExpiredVerificationModalCandidateInternal(frame)
);

// PDD uses this exact terminal message when the challenge itself has expired.
// Keep it narrower than the general expired detector: a live slider, image
// challenge, login page, or a different error must never be dismissed by the
// timeout cleanup path.
export const findTimedOutVerificationModalCandidate = async (frame) => {
  // The explicit terminal copy is safe to close even while the old slider
  // DOM is still mounted; it is no longer an actionable challenge.
  const candidate = await findExpiredVerificationModalCandidateInternal(frame, {
    allowLiveControls: true,
    patternSource: '验证时间过长[，,]\\s*请重试',
  });
  const terminalText = String(candidate?.terminalText || '').replace(/\s+/gu, '');
  return candidate && /^验证时间过长[，,]请重试$/u.test(terminalText) ? candidate : null;
};

export const closeExpiredVerificationModal = async (page,detection) => {
  if(!page||page.isClosed())return {closed:false,reason:'page-closed'};
  const frame=page.frames().find(candidate=>candidate.url()===detection.frameUrl);
  if(!frame)return {closed:false,reason:'expired-modal-frame-missing'};
  const current=await findExpiredVerificationModalCandidate(frame);
  if(!current)return {closed:false,reason:'expired-modal-no-longer-terminal'};
  const candidates=frame.locator(current.closeSelector);
  for(let index=0;index<await candidates.count();index++){
    const candidate=candidates.nth(index);
    const localBox=await candidate.evaluate(element=>{const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}).catch(()=>null);
    const expected=current.closeBoundingBox;
    if(!localBox||Math.abs(localBox.x-expected.x)>2||Math.abs(localBox.y-expected.y)>2
      ||Math.abs(localBox.width-expected.width)>2||Math.abs(localBox.height-expected.height)>2)continue;
    if(!await candidate.isVisible().catch(()=>false))continue;
    await candidate.click({force:true,timeout:1500});
    return {closed:true,expired:true,selector:current.closeSelector,frameUrl:frame.url(),
      terminalText:current.terminalText,method:'explicit-expired-modal-x',closedAt:new Date().toISOString()};
  }
  return {closed:false,expired:true,reason:'expired-modal-exact-x-not-found'};
};

export const closeTimedOutVerificationModal = async (page,detection) => {
  if (!page||page.isClosed())return {closed:false,reason:'page-closed'};
  const frames = page.frames();
  const expectedFrameUrl = String(detection?.frameUrl || '');
  frames.sort((left,right) => Number(right.url() === expectedFrameUrl) - Number(left.url() === expectedFrameUrl));
  for (const frame of frames) {
    const current = await findTimedOutVerificationModalCandidate(frame);
    if (!current) continue;
    const candidates = frame.locator(current.closeSelector);
    for(let index=0;index<await candidates.count();index++){
      const candidate = candidates.nth(index);
      const localBox = await candidate.evaluate(element=>{
        const r=element.getBoundingClientRect();
        return {x:r.x,y:r.y,width:r.width,height:r.height};
      }).catch(()=>null);
      const expected = current.closeBoundingBox;
      if(!localBox||Math.abs(localBox.x-expected.x)>2||Math.abs(localBox.y-expected.y)>2
        ||Math.abs(localBox.width-expected.width)>2||Math.abs(localBox.height-expected.height)>2)continue;
      if(!await candidate.isVisible().catch(()=>false))continue;
      await candidate.click({force:true,timeout:1500});
      return {closed:true,expired:true,selector:current.closeSelector,frameUrl:frame.url(),
        terminalText:current.terminalText,method:'explicit-timed-out-modal-x',closedAt:new Date().toISOString()};
    }
    if (current.closeMethod === 'coordinate') {
      const body = frame.locator('body');
      const bodyBox = await body.boundingBox().catch(()=>null);
      const bodyRect = await body.evaluate(element=>{
        const r=element.getBoundingClientRect();
        return {x:r.x,y:r.y};
      }).catch(()=>null);
      const expected = current.closeBoundingBox;
      const point = bodyBox && bodyRect ? {
        x: bodyBox.x + Number(expected.x) + Number(expected.width) / 2 - bodyRect.x,
        y: bodyBox.y + Number(expected.y) + Number(expected.height) / 2 - bodyRect.y,
      } : null;
      if (point) {
        await page.mouse.click(point.x,point.y,{delay:35});
        return {closed:true,expired:true,selector:'expired-modal-coordinate-close',frameUrl:frame.url(),
          terminalText:current.terminalText,method:'explicit-timed-out-modal-coordinate-x',closedAt:new Date().toISOString()};
      }
    }
  }
  return {closed:false,expired:false,reason:'timed-out-modal-not-found'};
};
