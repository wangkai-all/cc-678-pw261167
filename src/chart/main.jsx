import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ChartPage from './ChartPage.jsx';
import '../styles/fonts.css';
import '../styles/tokens.css';
import '../styles/chart.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ChartPage />
  </StrictMode>,
);
