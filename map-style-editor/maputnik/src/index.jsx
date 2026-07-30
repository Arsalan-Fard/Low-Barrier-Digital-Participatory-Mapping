import { IconContext } from "react-icons";
import { createRoot } from 'react-dom/client';

import './favicon.ico'
import './styles/index.scss'
import './i18n';
import App from './components/App';

function renderApp() {
  const root = createRoot(document.querySelector("#app"));
  root.render(
    <IconContext.Provider value={{className: 'react-icons'}}>
      <App/>
    </IconContext.Provider>
  );

  // Hide the loader.
  document.querySelector(".loading").style.display = "none";
}

// Firefox can execute a cached module before the linked stylesheet has
// completed loading. MapLibre measures its container during construction, so
// wait for the full load event to avoid creating a zero-sized/unstyled canvas.
if (document.readyState === "complete") {
  renderApp();
} else {
  window.addEventListener("load", renderApp, {once: true});
}
