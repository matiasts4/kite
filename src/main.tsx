import ReactDOM from 'react-dom/client';
import { App } from './App';
import { MotionProvider } from './motion/standard/context';
import './index.css';

// Preseed theme and palette before the first paint
document.documentElement.setAttribute('data-theme', 'dark');
document.documentElement.setAttribute('data-palette', 'kite-dark');
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
} else {
  ReactDOM.createRoot(root).render(
    <MotionProvider>
      <App />
    </MotionProvider>
  );
}
