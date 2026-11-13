const img = document.getElementById('img');
const badge = document.getElementById('badge');
window.api.onOverlayImage((url) => { img.src = url; });
window.api.onOverlay(({ opacity, match }) => {
  img.style.opacity = opacity / 100;
  badge.textContent = '일치도 ' + (match == null ? '--' : match) + '%';
});
