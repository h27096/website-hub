/* Public, repository-owned history; no authentication or backend required. */
(() => {
  'use strict';
  const data = ROBCO_VERSION_HISTORY;
  const version = data.releases[0].version;
  document.querySelectorAll('[data-hub-version]').forEach(element => {
    element.textContent = 'ROBCO WEBSITE HUB // VERSION ' + version;
  });

  const dialog = document.createElement('dialog');
  dialog.className = 'version-history-dialog';
  dialog.id = 'versionHistory';
  dialog.setAttribute('aria-labelledby', 'versionHistoryTitle');
  const heading = document.createElement('h1');
  heading.id = 'versionHistoryTitle';
  heading.textContent = 'VERSION / UPDATE LOG';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'CLOSE VERSION HISTORY';
  close.autofocus = true;
  close.addEventListener('click', () => dialog.close());
  const header = document.createElement('header');
  header.append(heading, close);
  const current = document.createElement('p');
  current.className = 'version-history-current';
  current.textContent = 'ROBCO WEBSITE HUB // VERSION ' + version;
  const note = document.createElement('p');
  note.textContent = 'OFFICIAL REPOSITORY RECORD // SHARED BY ALL TERMINALS';
  dialog.append(header, current, note);

  function section(title) {
    const element = document.createElement('section');
    const label = document.createElement('h2');
    label.textContent = title;
    element.append(label);
    dialog.append(element);
    return element;
  }
  const releases = section('RELEASED / VERSION HISTORY');
  data.releases.forEach((release, index) => {
    const entry = document.createElement('article');
    const title = document.createElement('h3');
    title.textContent = release.version + (index === 0 ? ' // CURRENT' : ' // RELEASED');
    const list = document.createElement('ul');
    release.changes.forEach(change => {
      const item = document.createElement('li');
      item.textContent = change;
      list.append(item);
    });
    entry.append(title, list);
    releases.append(entry);
  });
  const roadmap = section('COMING FEATURES / ROADMAP');
  const planned = document.createElement('p');
  planned.textContent = 'PLANNED ONLY // NOT YET IMPLEMENTED';
  roadmap.append(planned);
  data.roadmap.forEach(feature => {
    const entry = document.createElement('article');
    const title = document.createElement('h3');
    title.textContent = feature.version + ' // UPCOMING';
    const description = document.createElement('p');
    description.textContent = feature.title;
    entry.append(title, description);
    roadmap.append(entry);
  });
  document.body.append(dialog);
  window.openVersionHistory = () => {
    if (!dialog.open) dialog.showModal();
  };
})();
