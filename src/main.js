const Apify = require('apify');

const dedupAfterLoadFn = require('./dedup-after-load');
const dedupAsLoadingFn = require('./dedup-as-loading');
const { validateInput } = require('./input');
const { betterSetInterval, getRealDatasetId } = require('./utils');
const { MODES } = require('./consts');

const { DEDUP_AFTER_LOAD, DEDUP_AS_LOADING } = MODES;
const { log } = Apify.utils;

Apify.main(async () => {
    // Get input of your actor
    const input = await Apify.getInput();
    console.log('My input:');
    console.dir(input);

    // We limit the upload batch size because each batch must finish in the 10 seconds on migratio event
    if (input.uploadBatchSize > 1000) {
        input.uploadBatchSize = 1000;
    }

    const {
        datasetIds,
        // If no dedup fields are supplied, we skip the deduping
        fields,
        // Also can be a name of dataset (can be created by this actor)
        outputDatasetId,
        uploadBatchSize = 1000,
        batchSizeLoad = 50000,
        parallelLoads = 10,
        parallelPushes = 5,
        offset,
        limit,
        mode = DEDUP_AFTER_LOAD,
        output = 'unique-items',
        outputTo = 'dataset',
        preDedupTransformFunction = '(items) => items',
        postDedupTransformFunction = '(items) => items',
        verboseLog = false,
        // Useful to reduce memory/traffic
        fieldsToLoad,
        // Items from these datasets will be used only to dedup against
        // Will automatically just load fields needed for dedup
        // These datasets needs to be loaded before the outputing datasets
        datasetIdsOfFilterItems,

        // Just debugging dataset duplications
        debugPlatform = false,
    } = input;

    if (debugPlatform) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    validateInput({ datasetIds, fields, output, mode, outputTo, preDedupTransformFunction, postDedupTransformFunction });
    const realOutputDatasetId = await getRealDatasetId(outputDatasetId);

    const preDedupTransformFn = eval(preDedupTransformFunction);
    const postDedupTransformFn = eval(postDedupTransformFunction);

    const pushState = (await Apify.getValue('PUSHED')) || {};
    Apify.events.on('persistState', async () => {
        await Apify.setValue('PUSHED', pushState);
    });

    const migrationState = {
        isMigrating: false,
    };

    const migrationCallback = async () => {
        migrationState.isMigrating = true;
        log.warning(`Migrating or aborting event: Actor will persist current state and stop processing until is fully migrated.`);
    };
    Apify.events.on('migrating', migrationCallback);
    Apify.events.on('aborting', migrationCallback);

    // This is a bit dirty but we split each batch for parallel processing so it needs to grow by parallels
    const finalUploadBatchSize = uploadBatchSize * parallelPushes;

    if (mode === DEDUP_AS_LOADING && batchSizeLoad !== finalUploadBatchSize) {
        // See NOTE in persistedPush
        log.warning(`For dedup-as-loading mode, batchSizeLoad must equal uploadBatchSize. Setting batch size to ${finalUploadBatchSize}`);
    }

    const context = {
        datasetIds,
        // See NOTE in persistedPush
        batchSizeLoad: mode === DEDUP_AFTER_LOAD ? batchSizeLoad : finalUploadBatchSize,
        output,
        fields,
        parallelLoads,
        parallelPushes,
        outputDatasetId: realOutputDatasetId,
        uploadBatchSize: finalUploadBatchSize,
        outputTo,
        offset,
        limit,
        fieldsToLoad: Array.isArray(fieldsToLoad) && fieldsToLoad.length > 0 ? fieldsToLoad : undefined,
        datasetIdsOfFilterItems,
        preDedupTransformFn,
        postDedupTransformFn,
        pushState,
        migrationState,
        verboseLog,
    };

    if (mode === DEDUP_AFTER_LOAD) {
        await dedupAfterLoadFn(context);
    } else if (mode === DEDUP_AS_LOADING) {
        await dedupAsLoadingFn(context);
    }

    await Apify.setValue('PUSHED', pushState);
});
