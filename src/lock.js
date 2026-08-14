'use strict';
// 锁屏界面逻辑:首次设置密码,之后输入密码解锁(带防暴力破解:失败次数提示 + 锁定倒计时)
(async () => {
  const has = (await window.api.lockHas()).has;
  const pw = document.getElementById('pw');
  const pw2 = document.getElementById('pw2');
  const msg = document.getElementById('lock-msg');
  const note = document.getElementById('lock-note');
  const btn = document.getElementById('btn');

  if (has) {
    pw2.style.display = 'none';
    btn.textContent = '解锁';
    note.textContent = '忘记密码将无法打开 App,数据不可恢复';
  } else {
    pw2.style.display = ''; // 首次设置要显示"确认密码"
    btn.textContent = '设置并进入';
    note.textContent = '之后每次打开都要输入此密码;请牢记,忘记无法恢复';
  }

  // 临时锁定模式:明确提示"关闭窗口将退出应用",防止误以为关掉就能解除锁定
  const mode = new URLSearchParams(location.search).get('mode');
  if (mode === 'temp') {
    note.textContent = '已锁定,请输入密码解锁;锁定中关闭窗口将退出应用';
  }

  // 加载时若正处锁定(暴力破解保护),直接禁用输入并倒计时
  const st = await window.api.lockStatus();
  if (st.ok && st.locked) startLockCountdown(st.remainingSec);

  // 锁定倒计时:禁用输入框/按钮,每秒刷新剩余秒数,到 0 恢复
  function startLockCountdown(sec) {
    btn.disabled = true;
    pw.disabled = true;
    let left = Math.max(1, sec);
    msg.textContent = `尝试次数过多,请 ${left} 秒后再试`;
    const timer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        pw.disabled = false;
        msg.textContent = '';
        pw.focus();
      } else {
        msg.textContent = `尝试次数过多,请 ${left} 秒后再试`;
      }
    }, 1000);
  }

  async function submit() {
    const p = pw.value;
    if (!p) { msg.textContent = '请输入密码'; return; }
    if (!has) {
      if (p.length < 8) { msg.textContent = '密码至少 8 位'; return; }
      if (p !== pw2.value) { msg.textContent = '两次输入的密码不一致'; return; }
      const r = await window.api.lockSetup(p);
      if (!r.ok) { msg.textContent = '设置失败: ' + r.error; return; }
    }
    const v = await window.api.lockVerify(p);
    if (!v.ok) {
      if (v.locked) startLockCountdown(v.remainingSec);
      else msg.textContent = `密码错误,还剩 ${v.attemptsLeft} 次机会`;
      pw.value = ''; pw2.value = ''; pw.focus();
      return;
    }
    msg.textContent = '解锁中…';
    const s = await window.api.lockSuccess(p);
    if (!s.ok) { msg.textContent = '解锁失败: ' + s.error; pw.value = ''; pw.focus(); }
  }

  btn.addEventListener('click', submit);
  // 回车提交,兼容中文输入法(组合中不触发)
  const onKey = (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) submit(); };
  pw.addEventListener('keydown', onKey);
  pw2.addEventListener('keydown', onKey);
})();
