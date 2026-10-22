import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

// Preseed theme and palette before the first paint
document.documentElement.setAttribute('data-theme', 'dark');
document.documentElement.setAttribute('data-palette', 'kite-dark');
document.documentElement.setAttribute('data-renderer-state', 'ready');
document.documentElement.setAttribute('lang', 'en');

const root = document.getElementById('root')!;
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('motion')) {
  void import('./motion/MotionLab').then(({ renderMotionLab }) => renderMotionLab(root));
} else {
  ReactDOM.createRoot(root).render(<App />);
}
