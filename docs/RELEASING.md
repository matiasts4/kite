# Releasing / actualizaciones

## Publicar una actualización (1 comando)
```
npm run release -- patch            # o minor | major | x.y.z
npm run release:dry                 # prueba: compila y firma, restaura versión, no publica
```
Hace: tests → bump (package.json, tauri.conf.json, Cargo.toml) → build NSIS firmado de
Kite Code → copia a `dist/feed/studio/` + `latest.json` → arranca solo el
feed server (`http://127.0.0.1:9101`) si no está corriendo → verifica el feed.
Si falla, restaura las versiones. No toca git en modo local.

## Cómo se entera la app
- Al abrir (8 s después, solo build release) y con el botón **Buscar** en la barra lateral.
- Errores clasificados (`network`, `signature`, `feed-not-found`, `no-asset`, `permissions`,
  `installer`, `unknown`) con detalle y "Copiar diagnóstico"; todo queda en `app.log`.
- Cambiar el feed sin recompilar: variable de entorno `KITE_UPDATE_URL`.

## Pasar a GitHub (cuando haya repo)
1. `git remote add origin ...`
2. Cambiar `endpoints` en `src-tauri/tauri.conf.json` a
   `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`
   (y quitar `dangerousInsecureTransportProtocol`).
3. `npm run release -- patch --github`

## Clave de firma
`~/.tauri/kite.key` (sin contraseña). **Respaldarla**: sin ella las apps instaladas no actualizan.

## Primer uso
Instalar una vez a mano un build que ya incluya el updater; desde ahí es automático.
