# ShotDrop server

Сервер для загрузки снимков из программы ShotDrop (скриншотер для Windows).

Один файл `server.js` на Node.js без зависимостей и Dockerfile. Снимки хранятся файлами в `/data/images`, имя файла состоит из 8 случайных букв и цифр. Ссылка ведёт прямо на картинку: `https://shots.example.com/Ab3dE9xZ.png`.

| Запрос | Что делает |
|---|---|
| `POST /api/upload` | multipart, поле `file`. Принимает PNG, JPEG, GIF и WebP (тип определяется по содержимому файла) и возвращает `{"url": "…/Ab3dE9xZ.png", "id": "Ab3dE9xZ"}` |
| `DELETE /api/<id>` | удаляет снимок |
| `GET /<id>.png` | отдаёт картинку, браузеры кэшируют её навсегда |
| `GET /health` | отвечает `ok` |

Для `/api/*` нужен заголовок `Authorization: Bearer <UPLOAD_TOKEN>`. Ошибки возвращаются как `{"error": "…"}`, и программа показывает этот текст в уведомлении.

**Переменные окружения**

| Переменная | Назначение |
|---|---|
| `UPLOAD_TOKEN` | обязательна, не короче 16 символов. Без неё сервер не запустится |
| `PUBLIC_URL` | начало ссылок, например `https://shots.example.com`. Если не задана, берётся из заголовков прокси |
| `MAX_UPLOAD_MB` | максимальный размер файла, по умолчанию 25 |
| `PORT`, `DATA_DIR` | по умолчанию `3000` и `/data` |

### Деплой в Coolify

1. **DNS.** Создать A-запись `shots.example.com` → IP сервера.
2. **Ресурс.** New Resource → этот репозиторий.
   - Build Pack: **Dockerfile**.
   - Base Directory: **`/`**.
   - Ports Exposes: **3000**.
3. **Domains.** Указать `https://shots.example.com`. HTTPS-сертификат Coolify выпустит сам.
4. **Environment Variables.**
   - `UPLOAD_TOKEN` — случайная строка. Её можно сгенерировать в PowerShell: `-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 40 | % {[char]$_})`.
   - `PUBLIC_URL=https://shots.example.com`.
5. **Persistent Storage.** Добавить Volume с Destination Path `/data`. **Без него все снимки пропадут при следующем деплое.**
6. **Deploy.** После деплоя проверить, что `https://shots.example.com/health` отвечает `ok`.
7. **ShotDrop.** Открыть Settings, в поле Upload URL указать `https://shots.example.com/api/upload`, в поле Token — тот же токен, затем нажать **Test upload**.

### Локальный запуск

```bash
UPLOAD_TOKEN=local-test-token-123 DATA_DIR=./data PORT=8788 node server.js
# Upload URL в ShotDrop: http://localhost:8788/api/upload
```

Требуется Node.js 20+ (в Docker используется `node:22-alpine`).
