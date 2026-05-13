import { Router } from 'express';
import { aiRuntimeManager } from '../services/aiRuntimeManager.js';
import { modelSelectionService } from '../services/modelSelectionService.js';

export const modelSelectionRouter = Router();

modelSelectionRouter.get('/models', async (_req, res) => {
  try {
    const models = await modelSelectionService.listLocalModels();
    res.json(models);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudieron listar los modelos locales de Ollama.';
    res.status(503).json({ error: message });
  }
});

modelSelectionRouter.get('/model-selection', async (_req, res) => {
  try {
    res.json(await modelSelectionService.getSelectionResponse());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo obtener la selección de modelo.';
    res.status(503).json({ error: message });
  }
});

modelSelectionRouter.post('/model-selection', async (req, res) => {
  const requestedModel = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!requestedModel) {
    res.status(400).json({ error: 'Debés enviar un modelo válido.' });
    return;
  }

  const runtimeStatus = await aiRuntimeManager.getStatus();
  if (runtimeStatus.activeJobsCount > 0) {
    res.status(409).json({
      error: 'No se puede cambiar el modelo mientras hay jobs IA activos. El cambio global aplica solo a jobs futuros.',
    });
    return;
  }

  try {
    const previousSelection = await modelSelectionService.getSelectionResponse();
    const nextSelection = await modelSelectionService.setActiveModel(requestedModel, 'frontend');

    console.log(`[model-selection] changed active model from ${previousSelection.activeModel} to ${nextSelection.activeModel}`);

    if (previousSelection.activeModel !== nextSelection.activeModel) {
      if (runtimeStatus.ownedByCurrentSession) {
        console.log(`[model-selection] unload previous model attempted for ${previousSelection.activeModel}`);
        await aiRuntimeManager.unloadModel(previousSelection.activeModel);
      } else {
        console.log(`[model-selection] unload previous model skipped for ${previousSelection.activeModel} (runtime externo)`);
      }
    }

    res.json(await modelSelectionService.getSelectionResponse());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo actualizar la selección de modelo.';
    res.status(400).json({ error: message });
  }
});
