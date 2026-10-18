# Security & Repository Exclusion Guide

Este repositorio está configurado para desarrollo y publicación segura de **Kite Code**.

## Directorios y Artefactos Excluidos

Por razones de seguridad, higiene del repositorio y protección de datos locales, los siguientes directorios y archivos no deben rastrearse en el repositorio de Git:

1. **`scratch/`**: Contiene notas temporales de trabajo y capturas de diagnóstico local.
2. **`*-clipboard/`**: Directorio de almacenamiento temporal de imágenes del portapapeles en tiempo de ejecución.
3. **`*.sqlite`, `*.sqlite3`, `*.db`**: Bases de datos locales generadas en tiempo de ejecución (`AppData`).
4. **`*.exe`, `*.msi`**: Instaladores y binarios compilados locales generados por la toolchain de empaquetado.
5. **Claves de firma**: Claves privadas de Tauri (`*.key`).
