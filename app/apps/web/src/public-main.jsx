import React from 'react';
import { createRoot } from 'react-dom/client';
import PublicApp from './app/PublicApp.jsx';
import './styles.css';
import './public-trend.css';

createRoot(document.getElementById('root')).render(<PublicApp />);
