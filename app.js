const config = window.HERSPERIA_TEST_CONFIG;

if (!config) throw new Error("Hersperia test configuration is missing.");

const { dimensions, questions } = config;
const dimensionKeys = Object.keys(dimensions);
const questionMap = new Map(questions.map((question) => [question.id, question]));
const groupIds = [...new Set(questions.map((question) => question.groupId || question.id))];
const STORAGE_KEY = config.storageKey || `hersperia:quiz:${config.id}:v${config.contentVersion || 1}`;

const screens = {
  intro: document.getElementById("intro-screen"),
  quiz: document.getElementById("quiz-screen"),
  result: document.getElementById("result-screen"),
};

const els = {
  start: document.getElementById("start-button"),
  previous: document.getElementById("previous-result-button"),
  form: document.getElementById("question-form"),
  options: document.getElementById("answer-options"),
  title: document.getElementById("question-title"),
  description: document.getElementById("question-description"),
  section: document.getElementById("question-section"),
  guidance: document.getElementById("question-guidance"),
  count: document.getElementById("question-count"),
  progress: document.getElementById("progress-bar"),
  track: document.querySelector(".progress-track"),
  error: document.getElementById("question-error"),
  back: document.getElementById("back-button"),
  next: document.getElementById("next-button"),
  result: document.getElementById("result-content"),
  retake: document.getElementById("retake-button"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function validateConfig() {
  if (!questions.length) throw new Error("The test needs at least one question.");
  if (groupIds.length !== Number(config.flow?.totalGroups)) {
    throw new Error("flow.totalGroups must match the number of question groups.");
  }

  const seenQuestions = new Set();
  questions.forEach((question, index) => {
    if (!question.id || seenQuestions.has(question.id)) throw new Error("Each question needs a unique id.");
    seenQuestions.add(question.id);

    if (question.type === "choice") {
      if (!Array.isArray(question.options) || question.options.length < 2) throw new Error(`${question.id} needs answer options.`);
      const optionIds = new Set();
      question.options.forEach((option) => {
        if (!option.id || optionIds.has(option.id)) throw new Error(`${question.id} needs unique option ids.`);
        optionIds.add(option.id);
        Object.keys(option.scores || {}).forEach((key) => {
          if (!dimensions[key]) throw new Error(`${question.id} refers to an unknown result: ${key}`);
        });
      });
    } else if (question.type === "scale") {
      if (!dimensions[question.dimension]) throw new Error(`${question.id} refers to an unknown result.`);
      if (!Array.isArray(config.scaleLabels) || config.scaleLabels.length < 2) throw new Error("Scale questions need scaleLabels.");
    } else {
      throw new Error(`${question.id} has an unsupported question type.`);
    }

    if (question.showIf) {
      if (!Array.isArray(question.showIf.optionIds) || !question.showIf.optionIds.length) {
        throw new Error(`${question.id} needs at least one parent option.`);
      }
      const parentIndex = questions.findIndex((candidate) => candidate.id === question.showIf.questionId);
      if (parentIndex < 0 || parentIndex >= index) throw new Error(`${question.id} must reference an earlier question.`);
      const parent = questions[parentIndex];
      if (parent.type !== "choice") throw new Error(`${question.id} can only branch from a choice question.`);
      if ((parent.groupId || parent.id) !== (question.groupId || question.id)) {
        throw new Error(`${question.id} must share a groupId with its parent.`);
      }
      const parentOptionIds = new Set(parent.options.map((option) => option.id));
      question.showIf.optionIds.forEach((optionId) => {
        if (!parentOptionIds.has(optionId)) throw new Error(`${question.id} references an unknown parent option.`);
      });
    }
  });

  questions.filter((question) => question.kind === "gate").forEach((gate) => {
    const covered = new Map(gate.options.map((option) => [option.id, 0]));
    questions.filter((question) => question.showIf?.questionId === gate.id).forEach((child) => {
      child.showIf.optionIds.forEach((optionId) => covered.set(optionId, (covered.get(optionId) || 0) + 1));
    });
    covered.forEach((count, optionId) => {
      if (count !== 1) throw new Error(`${gate.id}.${optionId} must open exactly one follow-up question.`);
    });
  });
}

function applyContent() {
  document.title = `${config.brand.name} · ${config.brand.testName}`;
  document.querySelector('meta[name="description"]').setAttribute("content", config.intro.lead);
  document.getElementById("brand-subtitle").textContent = config.brand.chineseName;
  document.getElementById("quiz-brand-subtitle").textContent = config.brand.testName;
  document.getElementById("intro-eyebrow").textContent = config.intro.eyebrow;
  document.getElementById("intro-title").innerHTML = config.intro.titleLines.map(escapeHtml).join("<br />");
  document.getElementById("intro-lead").textContent = config.intro.lead;
  document.getElementById("test-meta").innerHTML = config.intro.meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("");
  document.getElementById("method-note-copy").textContent = config.intro.method;
  document.getElementById("edition-kicker").textContent = config.intro.editionKicker;
  document.getElementById("edition-copy").innerHTML = escapeHtml(config.intro.editionCopy).replaceAll("\n", "<br />");
  document.getElementById("aside-caption").textContent = config.intro.asideCaption;
  document.getElementById("privacy-copy").textContent = config.intro.privacy;
  document.getElementById("advice-copy").textContent = config.intro.advice;
  document.getElementById("disclaimer-copy").textContent = config.disclaimer;
  els.track.setAttribute("aria-valuemax", String(config.flow.totalGroups));
}

function blankState() {
  return { currentId: questions[0].id, answers: {}, result: null };
}

function isQuestionActive(question, answers) {
  if (!question.showIf) return true;
  return question.showIf.optionIds.includes(answers[question.showIf.questionId]);
}

function getActiveQuestions(answers = state?.answers || {}) {
  return questions.filter((question) => isQuestionActive(question, answers));
}

function validAnswer(question, answer) {
  if (question.type === "choice") return question.options.some((option) => option.id === answer);
  return Number.isInteger(answer) && answer >= 0 && answer < config.scaleLabels.length;
}

function sanitizeAnswers(rawAnswers) {
  const answers = {};
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) return answers;
  questions.forEach((question) => {
    const answer = rawAnswers[question.id];
    if (validAnswer(question, answer)) answers[question.id] = answer;
  });
  const activeIds = new Set(getActiveQuestions(answers).map((question) => question.id));
  Object.keys(answers).forEach((questionId) => {
    if (!activeIds.has(questionId)) delete answers[questionId];
  });
  return answers;
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!parsed || typeof parsed !== "object") return blankState();
    const answers = sanitizeAnswers(parsed.answers);
    const active = getActiveQuestions(answers);
    const allAnswered = active.every((question) => answers[question.id] !== undefined);
    const currentIsValid = active.some((question) => question.id === parsed.currentId);
    const firstUnanswered = active.find((question) => answers[question.id] === undefined);
    return {
      currentId: currentIsValid ? parsed.currentId : (firstUnanswered?.id || active.at(-1)?.id || questions[0].id),
      answers,
      result: allAnswered && parsed.result && typeof parsed.result === "object" ? calculateProfile(answers) : null,
    };
  } catch {
    return blankState();
  }
}

let state = loadState();

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The current session still works when device storage is unavailable.
  }
}

function pruneInactiveAnswers() {
  const activeIds = new Set(getActiveQuestions(state.answers).map((question) => question.id));
  Object.keys(state.answers).forEach((questionId) => {
    if (!activeIds.has(questionId)) delete state.answers[questionId];
  });
}

function showScreen(name) {
  Object.entries(screens).forEach(([key, screen]) => {
    screen.hidden = key !== name;
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function updateIntro() {
  const answered = Object.keys(state.answers).length;
  if (answered > 0 && !state.result) {
    els.start.textContent = "继续测试";
  } else if (state.result) {
    els.start.textContent = "再测一次";
  } else {
    els.start.textContent = "开始测试";
  }
  els.previous.hidden = !state.result;
}

function optionData(question) {
  if (question.type === "choice") {
    return question.options.map((option, index) => ({
      value: option.id,
      marker: String.fromCharCode(65 + index),
      label: option.label,
    }));
  }
  return config.scaleLabels.map((label, index) => ({
    value: String(index),
    marker: String(index + 1).padStart(2, "0"),
    label,
  }));
}

function renderOptions(question, selected) {
  els.options.dataset.kind = question.type;
  els.options.innerHTML = optionData(question)
    .map((option) => `
      <label class="answer-option">
        <input type="radio" name="answer" value="${escapeHtml(option.value)}" ${String(selected) === option.value ? "checked" : ""} />
        <span class="answer-index">${escapeHtml(option.marker)}</span>
        <span class="answer-label">${escapeHtml(option.label)}</span>
        <span class="answer-dot" aria-hidden="true"></span>
      </label>`) 
    .join("");
}

function currentQuestion() {
  return questionMap.get(state.currentId) || getActiveQuestions(state.answers)[0];
}

function renderQuestion() {
  const active = getActiveQuestions(state.answers);
  let question = currentQuestion();
  if (!question || !active.some((candidate) => candidate.id === question.id)) {
    question = active.find((candidate) => state.answers[candidate.id] === undefined) || active.at(-1);
    state.currentId = question.id;
  }

  const activeIndex = active.findIndex((candidate) => candidate.id === question.id);
  const groupId = question.groupId || question.id;
  const groupIndex = groupIds.indexOf(groupId);
  const groupNumber = groupIndex + 1;
  const activeInGroup = active.filter((candidate) => (candidate.groupId || candidate.id) === groupId);
  const answeredInGroup = activeInGroup.filter((candidate) => state.answers[candidate.id] !== undefined).length;
  const progressUnits = groupIndex + (answeredInGroup / activeInGroup.length);
  const progress = (progressUnits / config.flow.totalGroups) * 100;
  const hasLaterQuestion = activeIndex < active.length - 1 || questions.some((candidate) => candidate.showIf?.questionId === question.id);

  els.title.textContent = question.prompt;
  els.description.textContent = question.description || "";
  els.description.hidden = !question.description;
  els.section.textContent = question.section || "测试题";
  els.guidance.textContent = question.guidance || (question.kind === "followup"
    ? "这是根据上一题出现的针对性追问。"
    : "选择最接近你过去 12 个月真实状态的一项。");
  els.count.textContent = `主题 ${String(groupNumber).padStart(2, "0")} / ${config.flow.totalGroups}${question.kind === "followup" ? " · 追问" : ""}`;
  els.progress.style.width = `${progress}%`;
  els.track.setAttribute("aria-valuenow", String(Number(progressUnits.toFixed(2))));
  els.back.hidden = activeIndex === 0;
  els.next.textContent = hasLaterQuestion ? "下一题" : "查看结果";
  els.error.hidden = true;
  renderOptions(question, state.answers[question.id]);
  saveState();
}

function selectedOption(question, answer) {
  if (question.type !== "choice") return null;
  return question.options.find((option) => option.id === answer) || null;
}

function calculateProfile(answers) {
  const active = getActiveQuestions(answers);
  const points = Object.fromEntries(dimensionKeys.map((key) => [key, 0]));
  const maximums = Object.fromEntries(dimensionKeys.map((key) => [key, 0]));
  const evidenceEntries = [];
  const assets = [];
  const historyEntries = [];
  const contextEntries = [];
  const constraintEntries = [];
  const routes = [];

  active.forEach((question) => {
    const answer = answers[question.id];
    if (answer === undefined) return;
    const option = selectedOption(question, answer);
    if (option) {
      if (option.evidence) {
        evidenceEntries.push({
          text: option.evidence,
          dimensions: Object.keys(option.scores || {}),
          priority: question.kind === "followup" ? 3 : 2,
        });
      }
      if (option.asset) assets.push(option.asset);
      if (option.history) historyEntries.push({ text: option.history, priority: question.kind === "followup" ? 3 : 1 });
      if (option.context) contextEntries.push({ text: option.context, priority: question.kind === "followup" ? 3 : 1 });
      if (option.constraint) constraintEntries.push(option.context || option.history || option.label);
      if (option.route) routes.push(option.route);
    }
    if (question.score === false) return;

    const weight = Number(question.weight) || (question.kind === "followup" ? 1.25 : 0.85);
    if (question.type === "scale") {
      const ratio = answer / Math.max(1, config.scaleLabels.length - 1);
      points[question.dimension] += (question.reverse ? 1 - ratio : ratio) * weight;
      maximums[question.dimension] += weight;
      return;
    }

    dimensionKeys.forEach((key) => {
      maximums[key] += Math.max(0, ...question.options.map((candidate) => Number(candidate.scores?.[key]) || 0)) * weight;
    });
    Object.entries(option?.scores || {}).forEach(([key, value]) => {
      points[key] += (Number(value) || 0) * weight;
    });
  });

  const scores = Object.fromEntries(dimensionKeys.map((key) => [
    key,
    maximums[key] ? Math.round((points[key] / maximums[key]) * 100) : 0,
  ]));
  const ranked = [...dimensionKeys].sort((a, b) => {
    const pointDifference = points[b] - points[a];
    return Math.abs(pointDifference) > 0.001 ? pointDifference : scores[b] - scores[a];
  });
  const primary = ranked[0];
  const secondary = ranked[1];
  const topPoints = points[primary];
  const secondaryPoints = points[secondary];
  const totalPoints = Object.values(points).reduce((sum, value) => sum + value, 0);
  const uniqueAssets = uniqueStrings(assets);
  const uniqueHistories = uniqueStrings(historyEntries.sort((a, b) => b.priority - a.priority).map((entry) => entry.text));
  const uniqueContexts = uniqueStrings(contextEntries.sort((a, b) => b.priority - a.priority).map((entry) => entry.text));
  const uniqueConstraints = uniqueStrings(constraintEntries);
  const uniqueRoutes = uniqueStrings(routes);
  let mode = "pattern";
  if (topPoints < 2.2) {
    if (uniqueConstraints.length >= 2) {
      mode = "context";
    } else if (uniqueAssets.length >= 4 && totalPoints < 1.2) {
      mode = "stable";
    } else if (totalPoints >= 2.2) {
      mode = "diffuse";
    } else {
      mode = "exploring";
    }
  }
  const hasSecondary = secondaryPoints >= 0.85;
  const primaryEvidence = evidenceEntries
    .filter((entry) => entry.dimensions.includes(primary))
    .sort((a, b) => b.priority - a.priority)
    .map((entry) => entry.text);
  const otherEvidence = evidenceEntries
    .filter((entry) => !entry.dimensions.includes(primary))
    .sort((a, b) => b.priority - a.priority)
    .map((entry) => entry.text);

  return {
    scores,
    points,
    primary,
    secondary,
    topPoints,
    secondaryPoints,
    totalPoints,
    hasSecondary,
    mode,
    stable: mode === "stable",
    signals: uniqueStrings([...primaryEvidence, ...otherEvidence]).slice(0, 3),
    assets: uniqueAssets.slice(0, 4),
    histories: uniqueHistories.slice(0, 3),
    contexts: uniqueContexts.slice(0, 3),
    constraints: uniqueConstraints.slice(0, 3),
    routes: uniqueRoutes.slice(0, 3),
    completedAt: new Date().toISOString(),
  };
}

function completeTest() {
  state.result = calculateProfile(state.answers);
  saveState();
  renderResult();
  showScreen("result");
}

function evidenceList(result) {
  const mode = result.mode || (result.stable ? "stable" : "pattern");
  const sourceByMode = {
    stable: [...result.assets, ...result.contexts, ...result.signals],
    exploring: [...result.routes, ...result.contexts, ...result.assets, ...result.signals],
    context: [...result.contexts, ...result.histories, ...result.assets, ...result.signals],
    diffuse: [...result.signals, ...result.histories, ...result.contexts, ...result.assets],
    pattern: [...result.signals, ...result.histories, ...result.contexts],
  };
  const primarySource = uniqueStrings(sourceByMode[mode] || sourceByMode.pattern);
  const fallback = mode === "stable"
    ? ["你的回答没有出现一条反复主导选择的单一阻力。"]
    : mode === "context"
      ? ["当前更值得先看现实资源边界，而不是急着归因于个人。"]
      : mode === "exploring"
        ? ["现有经历还不足以支持一个确定类型，先保留开放判断。"]
        : mode === "diffuse"
          ? ["目前有几条轻微信号，但没有任何一条足以单独定义你。"]
        : ["你的一项回答提示，这条线索值得继续观察。"];
  return (primarySource.length ? primarySource : fallback).slice(0, 3);
}

function dossierItems(result, profile, primary, secondary) {
  const mode = result.mode || (result.stable ? "stable" : "pattern");
  let combination = result.hasSecondary
    ? `${dimensions[primary].short} × ${dimensions[secondary].short} 的组合解读`
    : `${dimensions[primary].short} 的单线深读`;
  if (mode === "stable") combination = result.topPoints > 0 ? "你的稳定资源 × 轻微信号组合解读" : "你的稳定资源与下一阶段增长杠杆";
  if (mode === "exploring") combination = "已有线索 × 待验证方向的探索地图";
  if (mode === "context") combination = "现实条件 × 可用资源的边界图";
  if (mode === "diffuse") combination = "多点轻微信号的关系图";
  const history = result.histories.length
    ? "你过去有效秩序的复建路径"
    : (mode === "stable"
      ? "当前有效秩序的保留与升级图"
      : mode === "context"
        ? "基本盘保护与温和重启图"
        : mode === "exploring"
          ? "第一份真实证据建立计划"
          : mode === "diffuse"
            ? "第一条减阻实验选择卡"
            : "你的第一套增长秩序搭建图");
  return uniqueStrings([
    combination,
    history,
    profile.dossier?.[0],
    "30 天个人行动地图与本月启动日历",
  ]).slice(0, 4);
}

function validPurchaseUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function resultLabel(result) {
  const mode = result.mode || (result.stable ? "stable" : "pattern");
  if (mode === "stable") return config.result.stableLabel;
  if (mode === "exploring") return config.result.exploringLabel;
  if (mode === "context") return config.result.contextLabel;
  if (mode === "diffuse") return config.result.diffuseLabel;
  return dimensions[result.primary].short;
}

function renderOffer(result, profile) {
  if (!config.offer?.enabled) return "";
  const purchaseUrl = validPurchaseUrl(config.offer.purchaseUrls?.[result.primary] || config.offer.purchaseUrls?.default || "");
  const items = dossierItems(result, profile, result.primary, result.secondary);
  const action = purchaseUrl
    ? `<a class="button button-primary dossier-cta" href="${escapeHtml(purchaseUrl)}" target="_blank" rel="noopener">${escapeHtml(config.offer.ctaLabel)}</a>`
    : `<button id="dossier-button" class="button button-primary dossier-cta" type="button" aria-controls="dossier-pending" aria-expanded="false">${escapeHtml(config.offer.pendingLabel)}</button>`;

  return `
    <section class="dossier-preview" aria-labelledby="dossier-title">
      <div class="dossier-copy">
        <p class="result-kicker">${escapeHtml(config.offer.eyebrow)}</p>
        <h2 id="dossier-title">${escapeHtml(config.offer.title)}</h2>
        <p>${escapeHtml(config.offer.description)}</p>
        ${action}
        <p id="dossier-pending" class="dossier-pending" hidden>${escapeHtml(config.offer.pendingMessage)}</p>
        <p class="dossier-note">${escapeHtml(config.offer.note)}</p>
      </div>
      <div class="locked-list" aria-label="付费档案包含内容">
        ${items.map((item, index) => `
          <div class="locked-row">
            <span>0${index + 1}</span>
            <strong>${escapeHtml(item)}</strong>
            <span class="lock-mark" aria-hidden="true">锁</span>
          </div>`).join("")}
      </div>
    </section>`;
}

function renderResult() {
  if (!state.result) return;
  const result = state.result;
  const mode = result.mode || (result.stable ? "stable" : "pattern");
  const primaryProfile = dimensions[result.primary];
  const secondaryProfile = dimensions[result.secondary];
  const profileByMode = {
    stable: config.stableResult,
    exploring: config.exploringResult,
    context: config.contextResult,
    diffuse: config.diffuseResult,
    pattern: primaryProfile,
  };
  const profile = profileByMode[mode] || primaryProfile;
  const evidences = evidenceList(result);
  const hasAnyPressure = result.topPoints > 0;
  let companionLabel = "第二条线索";
  let companionTitle = "当前没有形成第二条明显线索";
  let companionCopy = "这次答案更集中地指向一条主线，不需要为了显得复杂而再增加一个标签。";
  if (mode === "pattern" && result.hasSecondary) {
    companionLabel = `伴随模式 · ${secondaryProfile.short}`;
    companionTitle = secondaryProfile.title;
    companionCopy = secondaryProfile.soothe;
  } else if (mode === "stable") {
    companionLabel = hasAnyPressure ? `轻微线索 · ${primaryProfile.short}` : "已有资源";
    companionTitle = hasAnyPressure ? primaryProfile.title : "没有单一突出阻力";
    companionCopy = hasAnyPressure
      ? `这条线索目前不强，不必急着给自己贴标签。只要留意它是否在未来一个月反复出现：${primaryProfile.watch}`
      : (result.assets[0] || "你目前更适合保护已有节奏，再等待真实问题出现。");
  } else if (mode === "exploring") {
    companionLabel = "建议入口";
    companionTitle = "先用一次小行动换取判断依据";
    companionCopy = result.routes[0] || "选一个成本很低、七天内能完成的小验证，比现在确定一个人格类型更有价值。";
  } else if (mode === "context") {
    companionLabel = "现实边界";
    companionTitle = "先把可用资源算清楚";
    companionCopy = result.contexts[0] || "当前更值得先保护现金流、健康与必要责任，再寻找不伤害基本盘的小入口。";
  } else if (mode === "diffuse") {
    companionLabel = "优先次序";
    companionTitle = "先处理最常重复的一条"
    companionCopy = result.signals[0] || "同时处理所有轻微信号只会再次分散资源；先用七天验证其中一条。";
  }
  const historyNote = result.histories[0]
    ? `<p class="history-note"><strong>关于过去：</strong>${escapeHtml(result.histories[0])}</p>`
    : "";
  const routeNote = result.routes[0]
    ? `<div class="route-note"><span>按你的答案，第一步更适合</span><p>${escapeHtml(result.routes[0])}</p></div>`
    : "";
  const strengthHeading = mode === "pattern" ? "这套模式保护了你什么" : "你已经做对了什么";

  els.result.innerHTML = `
    <p class="result-kicker">${escapeHtml(config.result.kicker)}</p>
    <span class="result-badge">${escapeHtml(resultLabel(result))}</span>
    <h1 id="result-heading" class="result-heading">${escapeHtml(profile.title)}</h1>
    <p class="result-summary">${escapeHtml(profile.soothe)}</p>
    <p class="result-core">${escapeHtml(profile.core)}</p>

    <section class="evidence-panel" aria-labelledby="evidence-title">
      <p class="companion-label">PERSONAL ECHO</p>
      <h2 id="evidence-title">${escapeHtml(config.result.evidenceTitle)}</h2>
      <ul>${evidences.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      ${historyNote}
      ${routeNote}
    </section>

    <div class="result-grid">
      <section class="result-panel result-panel-feature">
        <p class="companion-label">这不是你的缺点</p>
        <h2>${escapeHtml(strengthHeading)}</h2>
        <p>${escapeHtml(profile.protects)}</p>
        <h3>此刻温柔地留意</h3>
        <p>${escapeHtml(profile.watch)}</p>
      </section>

      <section class="result-panel">
        <p class="companion-label">${escapeHtml(companionLabel)}</p>
        <h2>${escapeHtml(companionTitle)}</h2>
        <p>${escapeHtml(companionCopy)}</p>
        ${result.assets[0] ? `<div class="asset-note"><span>可复用资源</span><p>${escapeHtml(result.assets[0])}</p></div>` : ""}
      </section>
    </div>

    <section class="action-panel">
      <p class="result-kicker">${escapeHtml(config.result.actionKicker)}</p>
      <h2>${escapeHtml(config.result.actionTitle)}</h2>
      <ol class="action-list">${profile.actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ol>
    </section>

    <section class="ritual-panel">
      <div class="ritual-symbol" aria-hidden="true">✦</div>
      <div>
        <p class="companion-label">A SMALL RITUAL</p>
        <h2>${escapeHtml(config.result.ritualTitle)}</h2>
        <p class="ritual-action">${escapeHtml(profile.ritual)}</p>
        <p class="ritual-note">${escapeHtml(config.result.ritualNote)}</p>
      </div>
    </section>

    ${renderOffer(result, profile)}
  `;

  const dossierButton = document.getElementById("dossier-button");
  const pending = document.getElementById("dossier-pending");
  dossierButton?.addEventListener("click", () => {
    pending.hidden = false;
    dossierButton.setAttribute("aria-expanded", "true");
    pending.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  updateIntro();
}

function startOrResume() {
  if (state.result) {
    state = blankState();
    saveState();
  }
  const active = getActiveQuestions(state.answers);
  if (!active.some((question) => question.id === state.currentId)) {
    state.currentId = active.find((question) => state.answers[question.id] === undefined)?.id || active[0].id;
  }
  renderQuestion();
  showScreen("quiz");
}

function submitAnswer(answer) {
  const question = currentQuestion();
  if (!question || !validAnswer(question, answer)) return false;
  state.answers[question.id] = answer;
  pruneInactiveAnswers();
  const active = getActiveQuestions(state.answers);
  const currentIndex = active.findIndex((candidate) => candidate.id === question.id);
  const next = active[currentIndex + 1];
  if (!next) {
    const unanswered = active.find((candidate) => state.answers[candidate.id] === undefined);
    if (unanswered) {
      state.currentId = unanswered.id;
      saveState();
      renderQuestion();
      return true;
    }
    completeTest();
    return true;
  }
  state.currentId = next.id;
  saveState();
  renderQuestion();
  window.scrollTo({ top: 0, behavior: "smooth" });
  return true;
}

els.start.addEventListener("click", startOrResume);
els.previous.addEventListener("click", () => {
  renderResult();
  showScreen("result");
});

document.querySelectorAll("[data-go-home]").forEach((button) => {
  button.addEventListener("click", () => {
    updateIntro();
    showScreen("intro");
  });
});

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const question = currentQuestion();
  const raw = new FormData(event.currentTarget).get("answer");
  const answer = question.type === "scale" && raw !== null ? Number(raw) : raw;
  if (raw === null || !validAnswer(question, answer)) {
    els.error.hidden = false;
    return;
  }
  submitAnswer(answer);
});

els.back.addEventListener("click", () => {
  const active = getActiveQuestions(state.answers);
  const index = active.findIndex((question) => question.id === state.currentId);
  if (index <= 0) return;
  state.currentId = active[index - 1].id;
  saveState();
  renderQuestion();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

els.retake.addEventListener("click", () => {
  state = blankState();
  saveState();
  updateIntro();
  showScreen("intro");
});

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const lifecycle = new AbortController();
  const register = (tool) => {
    try {
      void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => {});
    } catch {
      // Browsers without WebMCP support continue with the visible interface.
    }
  };

  register({
    name: "read_hersperia_test_state",
    title: "读取 Hersperia 测试进度",
    description: "读取当前主题、已答数量和已有结果，不改变测试状态。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() {
      const question = state.result ? null : currentQuestion();
      const groupNumber = question ? groupIds.indexOf(question.groupId || question.id) + 1 : null;
      return {
        test: config.brand.testName,
        currentTheme: groupNumber,
        totalThemes: config.flow.totalGroups,
        currentQuestion: question?.prompt || null,
        answeredCount: Object.keys(state.answers).length,
        estimatedQuestions: config.flow.estimatedQuestions,
        completed: Boolean(state.result),
        primaryResult: state.result ? resultLabel(state.result) : null,
      };
    },
  });

  register({
    name: "answer_current_hersperia_question",
    title: "回答当前 Hersperia 测试题",
    description: "按页面选项顺序，用 1 至当前题选项数回答并进入下一题。",
    inputSchema: {
      type: "object",
      properties: { answer: { type: "integer", minimum: 1, maximum: Math.max(...questions.map((question) => question.type === "choice" ? question.options.length : config.scaleLabels.length)) } },
      required: ["answer"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      if (state.result) throw new Error("测试已经完成，请在页面上选择重新测试后再作答");
      const question = currentQuestion();
      const optionIndex = Number(input?.answer) - 1;
      const answer = question.type === "choice" ? question.options[optionIndex]?.id : optionIndex;
      if (!validAnswer(question, answer)) throw new Error(`当前题请回答 1 到 ${optionData(question).length} 的整数`);
      showScreen("quiz");
      submitAnswer(answer);
      return state.result
        ? { completed: true, primaryResult: resultLabel(state.result) }
        : { completed: false, nextQuestion: currentQuestion().prompt };
    },
  });
}

validateConfig();
applyContent();
updateIntro();
if (state.result) renderResult();
registerWebMcpTools();

window.__HERSPERIA_TEST__ = {
  getState: () => JSON.parse(JSON.stringify(state)),
  getActiveQuestionIds: () => getActiveQuestions(state.answers).map((question) => question.id),
  reset: () => {
    state = blankState();
    saveState();
    updateIntro();
  },
};
