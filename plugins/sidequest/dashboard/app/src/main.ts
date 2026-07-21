import { mount } from 'svelte';
import App from './App.svelte';
import './styles/reset.css';
import '@fontsource-variable/newsreader/index.css';
import '@fontsource-variable/karla/index.css';
import './styles/theme.css';
import './styles/app.css';

mount(App, { target: document.getElementById('app')! });
