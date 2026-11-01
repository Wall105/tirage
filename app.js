(() => {
  'use strict';

  const STORAGE_KEY = 'squadir-halloween-tirage-v1';
  const ROSTER_REVISION = 1;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const prizes = window.TIRAGE_DATA;
  const $ = id => document.getElementById(id);
  const normalize = value => value.normalize('NFKC').trim().toLocaleLowerCase('fr');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const freshState = () => ({
    version: 1, rosterRevision: ROSTER_REVISION, selected: prizes[0].id,
    lists: Object.fromEntries(prizes.map(prize => [prize.id, [...prize.participants]])),
    history: [], excludeWinners: false, sound: true
  });
  let state = freshState();
  let storageAvailable = true;
  let spinning = false;
  let rotation = 0;
  let lastResult = null;
  let audioContext;
  let toastTimer;
  let confettiTimer;
  let tickTimer;
  let previousSpinFamily = -1;

  function cleanNames(lines) {
    const seen = new Set();
    return lines.map(name => name.trim()).filter(name => {
      const key = normalize(name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved || saved.version !== 1 || typeof saved !== 'object') return;
      if (prizes.some(prize => prize.id === saved.selected)) state.selected = saved.selected;
      for (const prize of prizes) {
        const names = saved.lists?.[prize.id];
        if (Array.isArray(names) && names.length <= 100 && names.every(name => typeof name === 'string' && name.length <= 40 && name.trim())) {
          state.lists[prize.id] = cleanNames(names);
        }
      }
      if (Array.isArray(saved.history)) {
        state.history = saved.history.filter(item => item && typeof item.id === 'string' &&
          prizes.some(prize => prize.id === item.prizeId) && typeof item.name === 'string' &&
          item.name.trim() && item.name.length <= 40 && Number.isFinite(item.timestamp) &&
          item.timestamp >= 0 && item.timestamp <= 8640000000000000)
          .slice(-5000).map(item => ({ id: item.id, prizeId: item.prizeId, name: item.name, timestamp: item.timestamp }));
      }
      state.excludeWinners = saved.excludeWinners === true;
      state.sound = saved.sound !== false;
      state.rosterRevision = Number.isSafeInteger(saved.rosterRevision) && saved.rosterRevision >= 0 ? saved.rosterRevision : 0;
      if (state.rosterRevision < ROSTER_REVISION) {
        const fullLists = [];
        for (const id of ['pass-1', 'pass-2', 'pass-3', 'amazon']) {
          if (state.lists[id].some(name => normalize(name) === 'momoy')) continue;
          if (state.lists[id].length < 100) state.lists[id].push('MOMOY');
          else fullLists.push(prizes.find(prize => prize.id === id).title);
        }
        state.rosterRevision = ROSTER_REVISION;
        return { fullLists };
      }
    } catch (_) { storageAvailable = false; }
  }

  function notify(message) {
    $('toast').textContent = message;
    $('toast').classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('is-visible'), 4300);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      storageAvailable = true;
    } catch (_) {
      storageAvailable = false;
      notify('Les changements sont appliqués, mais la sauvegarde est indisponible dans ce navigateur.');
    }
  }

  const currentPrize = () => prizes.find(prize => prize.id === state.selected);
  const prizeDrawCount = (prizeId = state.selected) => state.history.filter(item => item.prizeId === prizeId).length;
  const isComplete = prize => prizeDrawCount(prize.id) >= prize.requiredDraws;
  function eligible(prizeId = state.selected) {
    const names = state.lists[prizeId];
    if (!state.excludeWinners) return [...names];
    const winners = new Set(state.history.map(item => normalize(item.name)));
    return names.filter(name => !winners.has(normalize(name)));
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#icon-${name}`);
    svg.append(use);
    return svg;
  }

  function renderPrizes() {
    const fragment = document.createDocumentFragment();
    prizes.forEach((prize, index) => {
      const drawn = isComplete(prize);
      const status = prize.requiredDraws > 1 ? `${Math.min(prizeDrawCount(prize.id), prize.requiredDraws)}/${prize.requiredDraws}` : drawn ? 'Tiré' : 'En lice';
      const card = element('button', `prize-card${prize.id === state.selected ? ' is-active' : ''}`);
      card.type = 'button';
      card.dataset.prize = prize.id;
      card.setAttribute('aria-pressed', String(prize.id === state.selected));
      card.disabled = spinning;
      card.style.setProperty('--prize-accent', prize.accent);
      const art = element('span', 'prize-icon');
      art.append(icon(index < 3 ? 'ticket' : index < 5 ? 'code' : 'gift'));
      const copy = element('span', 'prize-card-copy');
      copy.append(element('span', 'prize-card-kicker', `ROUE 0${index + 1}`));
      copy.append(element('strong', '', prize.shortTitle));
      copy.append(element('small', '', index < 3 ? `Pass n°${index + 1}` : index < 5 ? 'Event Discord' : '2 cartes cadeaux'));
      const meta = element('span', 'prize-card-meta');
      meta.append(element('span', 'prize-count', String(eligible(prize.id).length)));
      meta.append(element('span', `prize-status${drawn ? ' is-drawn' : ''}`, status));
      card.append(art, copy, meta);
      fragment.append(card);
    });
    $('prizeList').replaceChildren(fragment);
  }

  function renderWheel() {
    const names = eligible();
    const rotor = $('wheelRotor');
    rotor.replaceChildren();
    rotation = 0;
    rotor.setAttribute('transform', 'rotate(0 300 300)');
    const colors = ['#73351e', '#30203e', '#a64b23', '#452651', '#532722', '#654077'];
    const slice = 360 / Math.max(1, names.length);
    const point = degrees => [300 + 278 * Math.cos(degrees * Math.PI / 180), 300 + 278 * Math.sin(degrees * Math.PI / 180)];
    names.forEach((name, index) => {
      const start = index * slice - 90;
      const end = start + slice;
      const [sx, sy] = point(start);
      const [ex, ey] = point(end);
      const segment = document.createElementNS(SVG_NS, names.length === 1 ? 'circle' : 'path');
      if (names.length === 1) {
        segment.setAttribute('cx', '300'); segment.setAttribute('cy', '300'); segment.setAttribute('r', '278');
      } else {
        segment.setAttribute('d', `M300 300 L${sx} ${sy} A278 278 0 ${slice > 180 ? 1 : 0} 1 ${ex} ${ey} Z`);
      }
      segment.setAttribute('fill', colors[index % colors.length]);
      segment.setAttribute('stroke', '#d7ad8640');
      segment.setAttribute('stroke-width', '1');
      segment.setAttribute('class', 'wheel-segment');
      segment.setAttribute('data-index', index);
      rotor.append(segment);
      const label = document.createElementNS(SVG_NS, 'text');
      const mid = start + slice / 2;
      label.setAttribute('x', '558'); label.setAttribute('y', '300');
      label.setAttribute('dy', '.35em'); label.setAttribute('text-anchor', 'end');
      label.setAttribute('transform', `rotate(${mid} 300 300)`);
      label.setAttribute('fill', '#fff3e5');
      label.setAttribute('font-size', String(names.length > 45 ? 9 : names.length > 30 ? 11 : names.length > 22 ? 13 : 14));
      label.setAttribute('font-family', 'Arial, sans-serif');
      label.setAttribute('font-weight', '700');
      label.setAttribute('letter-spacing', '.35');
      label.setAttribute('class', 'wheel-label');
      label.setAttribute('data-index', index);
      label.textContent = name.length > 22 ? `${name.slice(0, 21)}…` : name;
      rotor.append(label);
    });
    $('wheel').setAttribute('aria-label', names.length ? `Roue ${currentPrize().title}, ${names.length} participants à chances égales` : 'Aucun participant éligible');
    $('wheelCount').textContent = names.length;
  }

  function renderParticipants() {
    const names = eligible();
    const search = normalize($('searchParticipants').value);
    const filtered = names.filter(name => normalize(name).includes(search));
    const fragment = document.createDocumentFragment();
    filtered.forEach(name => {
      const row = element('li', 'participant-row');
      row.append(element('span', 'participant-number', String(names.indexOf(name) + 1).padStart(2, '0')));
      row.append(element('span', 'participant-name', name));
      fragment.append(row);
    });
    if (!filtered.length) fragment.append(element('li', 'participants-empty', search ? 'Aucun pseudo trouvé.' : 'Aucun participant éligible. Modifie la liste ou les réglages.'));
    $('participantsList').replaceChildren(fragment);
    $('listCount').textContent = search ? `${filtered.length} / ${names.length}` : `${names.length} en lice`;
    $('participantCount').textContent = names.length;
    $('odds').textContent = names.length ? `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(100 / names.length)} % par personne` : 'Ajoute des participants pour lancer le tirage';
  }

  function renderHistory() {
    const fragment = document.createDocumentFragment();
    [...state.history].reverse().forEach(item => {
      const prize = prizes.find(entry => entry.id === item.prizeId);
      const row = element('li', 'history-item');
      const avatar = element('span', 'history-avatar', item.name.slice(0, 2).toUpperCase());
      avatar.style.setProperty('--prize-accent', prize.accent);
      const copy = element('span', 'history-copy');
      copy.append(element('strong', '', item.name), element('small', '', prize.title));
      const time = element('time', 'history-time', new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(new Date(item.timestamp)));
      time.dateTime = new Date(item.timestamp).toISOString();
      time.title = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Paris' }).format(new Date(item.timestamp));
      row.append(avatar, copy, time);
      fragment.append(row);
    });
    $('historyList').replaceChildren(fragment);
    $('historyCount').textContent = state.history.length;
    $('drawCount').textContent = state.history.length;
    $('remainingCount').textContent = prizes.filter(prize => !isComplete(prize)).length;
    $('emptyHistory').hidden = state.history.length > 0;
    $('exportButton').disabled = state.history.length === 0;
  }

  function updateControls() {
    const count = eligible().length;
    $('spinButton').disabled = spinning || count === 0;
    $('spinLabel').textContent = spinning ? 'Le sort est lancé…' : count ? 'INVOQUER LE SORT' : 'Aucun participant';
    $('shuffleButton').disabled = spinning || count < 2;
    $('editParticipantsButton').disabled = spinning;
    $('resetButton').disabled = spinning;
    $('excludeWinners').disabled = spinning;
    $('saveParticipants').disabled = spinning;
    $('settingsButton').disabled = spinning;
    $('soundButton').setAttribute('aria-pressed', String(state.sound));
    $('soundButton').setAttribute('aria-label', state.sound ? 'Désactiver le son' : 'Activer le son');
    $('soundButton').classList.toggle('is-muted', !state.sound);
    $('excludeWinners').checked = state.excludeWinners;
    $('stageStatus').textContent = spinning ? 'Le destin choisit son gagnant…' : count ? 'La roue est prête. À toi de jouer.' : 'Plus de participant éligible sur cette roue.';
  }

  function render() {
    const prize = currentPrize();
    $('selectedKicker').textContent = `TIRAGE 0${prizes.indexOf(prize) + 1} / 06`;
    $('selectedTitle').textContent = prize.title;
    $('selectedSubtitle').textContent = prize.subtitle;
    renderPrizes(); renderWheel(); renderParticipants(); renderHistory(); updateControls();
  }

  function selectPrize(id) {
    if (spinning || !prizes.some(prize => prize.id === id)) return;
    state.selected = id;
    $('searchParticipants').value = '';
    render(); save();
  }

  function randomIndex(maximum) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('Liste de participants invalide');
    if (!window.crypto?.getRandomValues) throw new Error('Ce navigateur ne permet pas le tirage sécurisé. Essaie un navigateur récent.');
    const range = 0x100000000;
    const limit = range - (range % maximum);
    const buffer = new Uint32Array(1);
    do { window.crypto.getRandomValues(buffer); } while (buffer[0] >= limit);
    return buffer[0] % maximum;
  }

  function unlockAudio() {
    if (!state.sound) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      audioContext ||= new AudioContext();
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
    } catch (_) { /* Le son est facultatif. */ }
  }

  function tone(frequency, duration = 0.04, volume = 0.035, delay = 0) {
    if (!state.sound || !audioContext || audioContext.state !== 'running') return;
    try {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = audioContext.currentTime + delay;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(volume, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain); gain.connect(audioContext.destination);
      oscillator.start(start); oscillator.stop(start + duration);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    } catch (_) { /* Une interruption audio ne doit jamais empêcher un tirage. */ }
  }

  function confetti() {
    $('confetti').replaceChildren();
    if (reducedMotion.matches) return;
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 55; i++) {
      const piece = element('span', 'confetti-piece');
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = ['#ff8c3a', '#ba7cf5', '#ffd39c', '#fff3e5'][i % 4];
      piece.style.animationDelay = `${Math.random() * 0.5}s`;
      piece.style.setProperty('--drift', `${Math.random() * 250 - 125}px`);
      piece.style.setProperty('--turn', `${Math.random() * 1080}deg`);
      fragment.append(piece);
    }
    $('confetti').append(fragment);
    clearTimeout(confettiTimer);
    confettiTimer = setTimeout(() => $('confetti').replaceChildren(), 4500);
  }

  function showWinner(result) {
    const prize = prizes.find(entry => entry.id === result.prizeId);
    const count = prizeDrawCount(prize.id);
    const winnerEligibility = state.excludeWinners
      ? 'Ce gagnant est désormais exclu des prochains tirages, sur toutes les roues.'
      : 'Ce gagnant reste en lice pour les prochains tirages.';
    $('winnerName').textContent = result.name;
    $('winnerPrize').textContent = prize.title;
    $('winnerNote').textContent = prize.id === 'amazon'
      ? `${count <= prize.requiredDraws ? `Carte ${count}/${prize.requiredDraws}` : 'Tirage supplémentaire'} · Deux cartes cadeaux Amazon. Résultat sauvegardé. ${winnerEligibility}`
      : `Résultat sauvegardé. ${winnerEligibility}`;
    $('removeWinnerButton').disabled = !state.lists[result.prizeId].some(name => normalize(name) === normalize(result.name));
    $('removeWinnerButton').textContent = 'Retirer de cette roue';
    $('nextPrizeButton').textContent = prize.id === 'amazon' && !isComplete(prize)
      ? 'Tirer la 2e carte Amazon'
      : prizes.some(entry => !isComplete(entry)) ? 'Roue suivante' : 'Revenir aux roues';
    $('winnerDialog').showModal();
    tone(523.25, 0.23, 0.045); tone(659.25, 0.28, 0.04, 0.12); tone(783.99, 0.5, 0.035, 0.24);
    confetti();
  }

  function createSpinPlan() {
    const range = (min, max) => min + (max - min) * randomIndex(1000001) / 1000000;
    const families = [0, 1, 2, 3].filter(family => family !== previousSpinFamily);
    const family = families[randomIndex(families.length)];
    const duration = range(20.5, 28.5);
    const tailDuration = range(5, 7);
    const tailSplit = range(0.42, 0.58);
    const tailRatio = range(0.25, 0.38);
    // L’aire de la fin lente vaut 23–25 degrés avant le léger ajustement des tours.
    const tailSpeed = 2 * range(23, 25) / (tailDuration * (tailSplit + tailRatio));
    const peak = range(800, 1100);
    const low = () => range(4, 14);
    const rebound = () => peak * range(0.68, 1.08);
    let speeds, weights;
    if (family === 0) {
      // Après l’accélération, la vitesse ne fait que diminuer jusqu’à l’arrêt.
      speeds = [0, peak, peak * range(0.72, 0.94), peak * range(0.25, 0.45), tailSpeed];
      weights = [1.6, 3.8, 4.5, 3.4];
    } else if (family === 1) {
      speeds = [0, peak, peak * range(0.65, 0.9), low(), rebound(), peak * range(0.22, 0.42), tailSpeed];
      weights = [1.7, 2.4, 2.7, 1.8, 2.3, 2.8];
    } else if (family === 2) {
      speeds = [0, peak, low(), rebound(), low(), rebound(), peak * range(0.2, 0.35), tailSpeed];
      weights = [1.5, 2.8, 1.6, 2.7, 1.4, 2.2, 2.5];
    } else {
      // La reprise arrive après un premier freinage plus long.
      speeds = [0, peak, peak * range(0.5, 0.7), low(), peak * range(0.45, 0.8), tailSpeed];
      weights = [1.7, 5.5, 4.2, 1.6, 2];
    }
    weights = weights.map(weight => weight * range(0.8, 1.2));
    const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
    const mainDuration = duration - tailDuration;
    const profile = [[0, 0]];
    let elapsed = 0;
    for (let i = 1; i < speeds.length; i++) {
      elapsed += mainDuration * weights[i - 1] / weightTotal;
      profile.push([i === speeds.length - 1 ? mainDuration : elapsed, speeds[i]]);
    }
    profile.push([mainDuration + tailDuration * tailSplit, tailSpeed * tailRatio], [duration, 0]);
    const distance = profile.slice(1).reduce((sum, [time, speed], index) => {
      const [previousTime, previousSpeed] = profile[index];
      return sum + (time - previousTime) * (previousSpeed + speed) / 2;
    }, 0);
    const turns = Math.max(1, Math.round(distance / 360 + range(-0.25, 0.25)));
    previousSpinFamily = family;
    return { family, profile, distance, duration, turns, tailDuration };
  }

  function spinMotion(plan, seconds) {
    let distance = 0;
    for (let i = 1; i < plan.profile.length; i++) {
      const [t0, v0] = plan.profile[i - 1];
      const [t1, v1] = plan.profile[i];
      const duration = t1 - t0;
      if (seconds >= t1) { distance += duration * (v0 + v1) / 2; continue; }
      const u = Math.max(0, (seconds - t0) / duration);
      // Intégrale de v0 + (v1-v0) × smoothstep(u), toujours positive.
      distance += duration * (v0 * u + (v1 - v0) * (u ** 3 - u ** 4 / 2));
      const speed = v0 + (v1 - v0) * (3 * u ** 2 - 2 * u ** 3);
      return { progress: Math.min(1, Math.max(0, distance / plan.distance)), speed: Math.max(0, speed / plan.distance) };
    }
    return { progress: 1, speed: 0 };
  }

  function spin() {
    if (spinning || document.querySelector('dialog[open]')) return;
    const names = eligible();
    if (!names.length) return;
    const shortAnimation = reducedMotion.matches;
    let index, plan;
    try {
      index = randomIndex(names.length);
      plan = shortAnimation ? null : createSpinPlan();
    } catch (error) { notify(error.message); return; }
    unlockAudio();
    spinning = true;
    renderPrizes(); updateControls();
    clearTimeout(tickTimer);
    $('wheel').classList.remove('is-ticking');
    $('wheel').classList.add('is-spinning');
    const slice = 360 / names.length;
    // Les secteurs commencent à -90°. Le gagnant arrive à droite, texte horizontal.
    const destination = ((90 - (index + 0.5) * slice) % 360 + 360) % 360;
    const start = rotation;
    const delta = ((destination - (start % 360)) + 360) % 360;
    const target = start + 360 * (plan?.turns || 0) + delta;
    const duration = shortAnimation ? 150 : plan.duration * 1000;
    const started = performance.now();
    let previousBoundary = Math.floor((start - 90) / slice);
    let stopped = false;
    let highlighted = -1;
    const segments = Array.from($('wheelRotor').querySelectorAll('.wheel-segment'));
    const labels = Array.from($('wheelRotor').querySelectorAll('.wheel-label'));
    function highlight(candidate) {
      if (candidate === highlighted) return;
      if (highlighted >= 0) {
        segments[highlighted].classList.remove('is-current');
        labels[highlighted].classList.remove('is-current');
      }
      highlighted = candidate;
      if (candidate >= 0) {
        segments[candidate].classList.add('is-current');
        labels[candidate].classList.add('is-current');
      }
    }
    const result = {
      id: window.crypto.randomUUID?.() || `${Date.now()}-${index}-${state.history.length}`,
      prizeId: state.selected, name: names[index], timestamp: 0
    };
    function frame(now) {
      if (stopped) return;
      const progress = Math.min(1, Math.max(0, (now - started) / duration));
      const motion = shortAnimation ? { progress: progress === 1 ? 1 : 0, speed: 0 } : spinMotion(plan, progress * plan.duration);
      rotation = start + (target - start) * motion.progress;
      $('wheelRotor').setAttribute('transform', `rotate(${rotation} 300 300)`);
      const boundary = Math.floor((rotation - 90) / slice);
      if (boundary !== previousBoundary && progress < 1 && !shortAnimation && names.length > 1) {
        tone(470 + progress * 190);
        $('wheel').classList.add('is-ticking');
        clearTimeout(tickTimer);
        tickTimer = setTimeout(() => $('wheel').classList.remove('is-ticking'), 120);
      }
      previousBoundary = boundary;
      const candidate = Math.floor(((90 - rotation) % 360 + 360) % 360 / slice);
      highlight(progress === 1 ? index : !shortAnimation && progress > 0.15 && motion.speed * (target - start) < 35 ? candidate : -1);
      if (progress < 1) { requestAnimationFrame(frame); return; }
      stopped = true;
      clearTimeout(tickTimer);
      $('wheel').classList.remove('is-ticking');
      $('wheel').classList.remove('is-spinning');
      result.timestamp = Date.now();
      state.history.push(result);
      if (state.history.length > 5000) state.history.shift();
      lastResult = result;
      save(); renderPrizes(); renderHistory(); renderParticipants(); updateControls();
      $('spinLabel').textContent = 'Le sort est scellé…';
      $('stageStatus').textContent = 'Le gagnant se révèle…';
      // Résultat déjà sauvegardé ; le tirage reste verrouillé pendant la lecture de la roue.
      const reveal = () => {
        spinning = false;
        renderPrizes(); updateControls();
        showWinner(result);
      };
      if (shortAnimation) reveal();
      else setTimeout(reveal, 1200);
    }
    requestAnimationFrame(frame);
  }

  function closeWinner() {
    $('winnerDialog').close();
    if (state.excludeWinners) renderWheel();
  }

  function editParticipants() {
    if (spinning) return;
    $('editTitle').textContent = currentPrize().title;
    $('participantsInput').value = state.lists[state.selected].join('\n');
    $('editHelp').textContent = 'Un pseudo par ligne · 100 participants maximum · 40 caractères par pseudo. Les doublons sont regroupés.';
    $('editError').textContent = '';
    $('editDialog').showModal();
  }

  function exportHistory() {
    if (!state.history.length) return;
    const quote = value => {
      let text = String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replaceAll('"', '""')}"`;
    };
    const rows = [['Date (Paris)', 'Cadeau', 'Gagnant']];
    state.history.forEach(item => {
      const prize = prizes.find(entry => entry.id === item.prizeId);
      rows.push([new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/Paris' }).format(new Date(item.timestamp)), prize.title, item.name]);
    });
    const csv = '\uFEFF' + rows.map(row => row.map(quote).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = element('a');
    link.href = url; link.download = 'gagnants-halloween.csv';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('L’historique a été exporté.');
  }

  $('prizeList').addEventListener('click', event => {
    const button = event.target.closest('[data-prize]');
    if (button) selectPrize(button.dataset.prize);
  });
  $('spinButton').addEventListener('click', spin);
  $('shuffleButton').addEventListener('click', () => {
    if (spinning) return;
    const names = [...state.lists[state.selected]];
    try {
      for (let i = names.length - 1; i > 0; i--) {
        const j = randomIndex(i + 1); [names[i], names[j]] = [names[j], names[i]];
      }
    } catch (error) { notify(error.message); return; }
    state.lists[state.selected] = names;
    render(); save(); notify('L’ordre des participants a été mélangé. Les chances restent égales.');
  });
  $('searchParticipants').addEventListener('input', renderParticipants);
  $('editParticipantsButton').addEventListener('click', editParticipants);
  $('cancelEdit').addEventListener('click', () => $('editDialog').close());
  $('editForm').addEventListener('submit', event => {
    event.preventDefault();
    if (spinning) return;
    const names = cleanNames($('participantsInput').value.split(/\r?\n/));
    if (!names.length) { $('editError').textContent = 'Ajoute au moins un participant.'; return; }
    if (names.length > 100) { $('editError').textContent = 'La liste peut contenir 100 participants maximum.'; return; }
    if (names.some(name => name.length > 40)) { $('editError').textContent = 'Un pseudo dépasse 40 caractères. Raccourcis-le avant d’enregistrer.'; return; }
    state.lists[state.selected] = names;
    $('editDialog').close();
    $('searchParticipants').value = '';
    render(); save(); notify(`${names.length} participants enregistrés pour cette roue.`);
  });
  $('settingsButton').addEventListener('click', () => { if (!spinning) $('settingsDialog').showModal(); });
  $('closeSettings').addEventListener('click', () => $('settingsDialog').close());
  $('excludeWinners').addEventListener('change', () => {
    if (spinning) { $('excludeWinners').checked = state.excludeWinners; return; }
    state.excludeWinners = $('excludeWinners').checked;
    render(); save();
    notify(state.excludeWinners ? 'Les gagnants de l’historique sont exclus de toutes les roues.' : 'Tous les participants des listes peuvent de nouveau gagner.');
  });
  $('resetButton').addEventListener('click', () => {
    if (spinning) return;
    $('settingsDialog').close(); $('resetDialog').showModal();
  });
  $('cancelReset').addEventListener('click', () => $('resetDialog').close());
  $('confirmReset').addEventListener('click', () => {
    if (spinning) return;
    state = freshState(); lastResult = null;
    $('resetDialog').close(); $('searchParticipants').value = '';
    render(); save(); notify('Les listes d’origine sont restaurées et l’historique est vide.');
  });
  $('soundButton').addEventListener('click', () => {
    state.sound = !state.sound;
    unlockAudio(); updateControls(); save();
    notify(state.sound ? 'Son activé.' : 'Son désactivé.');
  });
  $('fullscreenButton').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
      else notify('Le plein écran n’est pas disponible dans ce navigateur.');
    } catch (_) { notify('Le navigateur n’a pas autorisé le plein écran.'); }
  });
  document.addEventListener('fullscreenchange', () => $('fullscreenButton').setAttribute('aria-label', document.fullscreenElement ? 'Quitter le plein écran' : 'Passer en plein écran'));
  $('exportButton').addEventListener('click', exportHistory);
  $('closeWinner').addEventListener('click', closeWinner);
  $('winnerDialog').addEventListener('cancel', event => { event.preventDefault(); closeWinner(); });
  $('nextPrizeButton').addEventListener('click', () => {
    closeWinner();
    const prize = currentPrize();
    const next = prize.id === 'amazon' && !isComplete(prize) ? prize : prizes.find(entry => !isComplete(entry));
    if (next) selectPrize(next.id);
  });
  $('removeWinnerButton').addEventListener('click', () => {
    if (!lastResult || spinning) return;
    const id = lastResult.prizeId;
    state.lists[id] = state.lists[id].filter(name => normalize(name) !== normalize(lastResult.name));
    $('removeWinnerButton').disabled = true;
    $('removeWinnerButton').textContent = 'Retiré de cette roue';
    $('winnerNote').textContent = `${lastResult.name} a été retiré de cette roue. Les autres listes sont conservées.`;
    renderPrizes(); renderParticipants(); updateControls(); save();
  });
  $('winnerDialog').addEventListener('close', () => renderWheel());
  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.repeat || event.target !== document.body || document.querySelector('dialog[open]')) return;
    event.preventDefault(); spin();
  });

  const migrated = restore();
  if (migrated) save();
  render();
  if (migrated?.fullLists.length) notify(`MOMOY n’a pas été ajouté aux listes pleines (${migrated.fullLists.join(', ')}). Modifie ces listes pour libérer une place et l’ajouter.`);
  if (!storageAvailable) notify('Le site est prêt. La sauvegarde locale est indisponible dans ce navigateur.');
})();
