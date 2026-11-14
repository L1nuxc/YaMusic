# YaMusic

Музыкальный сервис с сервером на Rust, веб-интерфейсом на TypeScript и клиентом для Windows на Tauri.

## Windows x64

- `YaMusic-0.1.0-windows-x64-setup.exe` устанавливает приложение для текущего пользователя и при необходимости загружает WebView2.
- `YaMusic-0.1.0-windows-x64.exe` запускается без установки при наличии WebView2.

Клиент открывает [YaMusic](https://yamusic.pigboss.xyz/) в системном WebView2. Для входа через Telegram и воспроизведения нужен интернет. Локальная медиатека хранится в профиле приложения.

Для сборки нужны Node.js 24+, Rust для `x86_64-pc-windows-msvc`, Visual Studio C++ Build Tools и Windows SDK.

```powershell
npm ci
npm run build:windows -- -- --locked
```

Установщик появится в `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`.

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
