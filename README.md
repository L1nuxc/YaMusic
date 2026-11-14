# YaMusic

Музыкальный сервис с сервером на Rust, веб-интерфейсом на TypeScript и клиентом для Windows на Tauri.

## Windows x64

[Скачать Windows-версию](https://github.com/L1nuxc/YaMusic/releases/latest)

- `YaMusic-0.1.0-windows-x64-setup.exe` устанавливает приложение для текущего пользователя и при необходимости загружает WebView2.
- `YaMusic-0.1.0-windows-x64.exe` запускается без установки при наличии WebView2.

Клиент открывает [YaMusic](https://yamusic.pigboss.xyz/) в системном WebView2. Плейлисты, лайки, история и общие настройки хранятся в аккаунте. Скачанное доступно на этом компьютере через «Медиатека → Скачанное» и при запуске без сети. Для скачивания и входа через Telegram нужен интернет.

Для сборки нужны Node.js 24+, Rust для `x86_64-pc-windows-msvc`, Visual Studio C++ Build Tools и Windows SDK.

```powershell
npm ci
npm run build:windows -- -- --locked
```

Установщик появится в `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`.

Для выпуска с автообновлением задайте `YAMUSIC_UPDATE_PUBLIC_KEY` и `TAURI_SIGNING_PRIVATE_KEY` (или `TAURI_SIGNING_PRIVATE_KEY_PATH`) от одной пары ключей Tauri. При необходимости задайте `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Храните закрытый ключ в секрете и используйте ту же пару для следующих релизов. Загрузите установщик, его `.sig` и `latest.json` в GitHub Releases. В манифесте укажите версию релиза, HTTPS-ссылку на установщик и содержимое `.sig` под платформой `windows-x86_64-nsis`. [Формат манифеста Tauri](https://v2.tauri.app/plugin/updater/#static-json-file)

## Локальный запуск сайта

```powershell
npm ci
npm run setup:analysis
npm run dev
```

Интерфейс доступен по адресу http://127.0.0.1:5173, API — по адресу http://127.0.0.1:8000. Пример настроек находится в `backend/.env.example`.

```powershell
npm test
npm run build
npm run test:backend
```
