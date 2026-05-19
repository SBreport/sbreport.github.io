/* ============================================================
   main.js — 카드 슬롯은 index.html에 직접 인라인됨
   여기서는 페이지 번호 삽입·진행 점·스크롤·키보드만 처리

   카드 추가/제거:
     index.html의 #card-container 안에 .card-slot 블록을
     추가/제거하면 자동으로 진행 점·페이지 번호도 갱신됨
   ============================================================ */

const container   = document.getElementById('card-container');
const progressNav = document.getElementById('progress-nav');
const slots       = container.querySelectorAll('.card-slot');
const totalCards  = slots.length;

/* ── 페이지 번호 (N / 전체) 자동 삽입 ── */
slots.forEach((slot, index) => {
  const cardInner = slot.querySelector('.card-inner');
  if (cardInner) {
    const pageNum = document.createElement('div');
    pageNum.className = 'card-page-number';
    pageNum.textContent = `${index + 1} / ${totalCards}`;
    cardInner.appendChild(pageNum);
  }
});

/* ── 특정 카드로 스크롤 ── */
function scrollToCard(index) {
  if (slots[index]) {
    slots[index].scrollIntoView({ behavior: 'smooth' });
  }
}

/* ── 활성 점 갱신 ── */
function updateActiveDot(index) {
  const dots = progressNav.querySelectorAll('.progress-dot');
  dots.forEach((d, i) => d.classList.toggle('active', i === index));
}

/* ── 진행 점 생성 ── */
(function buildProgressDots() {
  for (let i = 0; i < totalCards; i++) {
    const dot = document.createElement('button');
    dot.className = 'progress-dot';
    dot.setAttribute('aria-label', `${i + 1}번 카드로 이동`);
    dot.addEventListener('click', () => scrollToCard(i));
    progressNav.appendChild(dot);
  }
  updateActiveDot(0);
})();

/* ── Intersection Observer로 현재 카드 추적 ── */
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const index = Array.from(slots).indexOf(entry.target);
        updateActiveDot(index);
      }
    });
  },
  {
    root: container,
    threshold: 0.6, /* 60% 이상 보이면 해당 카드로 인식 */
  }
);
slots.forEach((slot) => observer.observe(slot));

/* ── 키보드 화살표 / PageUp·Down 스크롤 지원 ── */
document.addEventListener('keydown', (e) => {
  if (!totalCards) return;

  const currentIndex = Array.from(slots).findIndex((slot) => {
    const rect = slot.getBoundingClientRect();
    return rect.top >= -10 && rect.top <= 10;
  });

  if (e.key === 'ArrowDown' || e.key === 'PageDown') {
    e.preventDefault();
    scrollToCard(Math.min(currentIndex + 1, totalCards - 1));
  } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
    e.preventDefault();
    scrollToCard(Math.max(currentIndex - 1, 0));
  }
});
