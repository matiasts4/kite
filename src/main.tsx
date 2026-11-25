import ReactDOM from 'react-dom/client';
import { App } from './App';
import { MotionProvider } from './motion/standard/context';
import { preseedThemeCustomizationsOnBoot } from './lib/themeCustomizations';
import './index.css';

// Preseed saved theme, palette, and surface customizations before the first paint
preseedThemeCustomizationsOnBoot();
document.documentElement.setAttribute('data-renderer-state', 'ready');
document.documentElement.setAttribute('lang', 'en');
document.body.classList.add('kite-app');

const root = document.getElementById('root')!;
const params = new URLSearchParams(window.location.search);
if (import.meta.env.DEV && params.has('animate')) {
  void import('./motion/animate/AnimateLab').then(({ renderAnimateLab }) =>
    renderAnimateLab(root)
  );
} else if (import.meta.env.DEV && params.has('motion')) {
  void import('./motion/MotionLab').then(({ renderMotionLab }) => renderMotionLab(root));
} else if (import.meta.env.DEV && params.has('ui-kit')) {
  void import('./components/ui/UiKitPreview').then(({ renderUiKitPreview }) =>
    renderUiKitPreview(root)
  );
} else {
  ReactDOM.createRoot(root).render(
    <MotionProvider>
      <App />
    </MotionProvider>
  );
}
