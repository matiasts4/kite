import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

// Preseed theme and palette identical to production bundle
document.documentElement.setAttribute('data-theme', 'dark');
document.documentElement.setAttribute('data-palette', 'kite-dark');
document.documentElement.setAttribute('data-renderer-state', 'ready');
document.documentElement.setAttribute('lang', 'en');

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
