'use strict';
void window.capturePicker.sources().then((sources) => {
  const root = document.getElementById('sources');
  for (const source of sources) {
    const button = document.createElement('button'),
      image = document.createElement('img'),
      label = document.createElement('span');
    image.src = source.thumbnail;
    image.alt = '';
    label.textContent = source.name;
    button.append(image, label);
    button.onclick = () => window.capturePicker.choose(source.id);
    root.append(button);
  }
});
document.getElementById('cancel').onclick = () => window.capturePicker.cancel();
