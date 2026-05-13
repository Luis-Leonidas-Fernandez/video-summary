# Grounding worker

Worker Python invocado por el backend Node para validar claims con grounding sobre chunks transcritos.

## Instalación

```bash
cd backend/grounding_worker
/usr/bin/python3 -m pip install -r requirements.txt
```

## Uso

El backend lo invoca automáticamente con:

```bash
python3 grounding_worker.py validate --manifest ... --claims ... --output ...
```
