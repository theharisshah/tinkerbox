import '@fontsource/fira-code/400.css'
import '@fontsource/fira-code/500.css'
import '@fontsource/fira-code/600.css'
import './style.css'
import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { prepare, start } from './bootstrap'
import { useUiStore } from './stores/ui'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)

app.config.errorHandler = (err, _instance, info) => {
  console.error(`Unhandled error (${info}):`, err)
  try {
    useUiStore(pinia).error(err, 'Something went wrong')
  } catch {
    // The UI store is not usable (very early failure); the console has the error.
  }
}

async function boot(): Promise<void> {
  try {
    await prepare()
  } catch (err) {
    console.error('Startup (settings/theme) failed:', err)
  }
  app.mount('#app')
  try {
    await start()
  } catch (err) {
    console.error('Startup failed:', err)
    useUiStore(pinia).error(err, 'Tinkerbox could not finish starting')
  }
}

void boot()
