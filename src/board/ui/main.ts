// Entry of the web board bundle: the stylesheet (a file, never inline: CSP default-src 'self') and the Vue app.
import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');
