// Tab switching — using event delegation on the tabs container
const tabsContainer = document.getElementById('tabs');
tabsContainer.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;

  // Deactivate all
  tabsContainer.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.provider-section').forEach(s => s.classList.remove('active'));

  // Activate clicked
  tab.classList.add('active');
  const section = document.getElementById('section-' + tab.dataset.provider);
  if (section) section.classList.add('active');
});

// Close page
document.getElementById('close-page').addEventListener('click', (e) => {
  e.preventDefault();
  window.close();
});
