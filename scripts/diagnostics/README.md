# Kite Code — Suite de Diagnóstico de Congelamientos (UI Hangs)

Este conjunto de scripts permite monitorizar, diagnosticar y correlacionar los bloqueos y detenciones ("No responde") de la interfaz de Kite Code tanto en modo Producción como en modo Desarrollo.

---

## 1. ¿Por qué ejecutar el monitor AFUERA de la aplicación?

**El script de monitoreo debe ejecutarse SIEMPRE en una ventana externa de PowerShell (fuera de Kite Code).**

- **Efecto Observador (Heisenbug):** Las terminales integradas dentro de Kite dependen de los hilos de renderizado de WebView2 y del bombeo de mensajes IPC (`read_terminal_output` cada 45 ms). Si la interfaz o el hilo principal de Kite se congela, la pantalla de la terminal interna también se congela y no puede emitir eventos en tiempo real.
- **Independencia absoluta del SO:** Al correr en una consola nativa independiente de Windows, el script utiliza llamadas directas de la API Win32 (`SendMessageTimeout`, `IsHungAppWindow`) con hilos dedicados para medir con precisión de milisegundos cuándo la ventana de Kite deja de bombear mensajes.
- **Cero ruido en la UI:** Ejecutar loops de alta frecuencia dentro de la aplicación genera llamadas IPC y re-renders adicionales en el mismo bucle de eventos que estamos auditando.

---

## 2. Scripts Disponibles

| Script | Descripción | Cómo Ejecutarlo |
|---|---|---|
| **`monitor-hangs.ps1`** | Monitor en tiempo real. Mide latencia del hilo de UI cada 400ms. Detecta inicios y recuperaciones de congelamientos y los guarda en `hangs.log`. | `powershell -ExecutionPolicy Bypass -File .\scripts\diagnostics\monitor-hangs.ps1` |
| **`diagnose-concurrency.ps1`** | Auditoría estática de concurrencia. Revisa instancias DEV y PROD simultáneas, puertos (1420, 9101), procesos hijos WebView2, bloqueos LOCK y tamaños de `app.log`. | `powershell -ExecutionPolicy Bypass -File .\scripts\diagnostics\diagnose-concurrency.ps1` |
| **`analyze-hang-logs.ps1`** | Correlacionador. Cruza los congelamientos registrados en `hangs.log` con los eventos internos de `app.log` de Tauri para identificar qué estaba haciendo la app en ese segundo exacto. | `powershell -ExecutionPolicy Bypass -File .\scripts\diagnostics\analyze-hang-logs.ps1` |

---

## 3. Guía Rápida de Uso

1. **Abrir una ventana externa de PowerShell (fuera de Kite):**
   - Presiona `Win + X` -> Terminal / PowerShell.
   - Navega al directorio del proyecto:
     ```powershell
     cd E:\kite
     ```
2. **Lanzar el monitor:**
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnostics\monitor-hangs.ps1
   ```
3. **Reproducir el escenario habitual:**
   - Deja Kite en segundo plano por 3 minutos (cambia a otra ventana o minimiza).
   - Vuelve a hacer clic sobre la ventana de Kite Code.
4. **Observar la consola del monitor:**
   - Si la aplicación se congela, verás una alerta en rojo con la duración exacta en segundos y los recursos (RAM/CPU/Hilos).
   - Cuando la ventana vuelva a responder, verás un aviso en verde con la duración total del congelamiento.
5. **Analizar la causa raíz:**
   - Ejecuta:
     ```powershell
     powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnostics\analyze-hang-logs.ps1
     ```
