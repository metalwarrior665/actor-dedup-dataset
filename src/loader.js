const Apify = require('apify');
const bluebird = require('bluebird');

const { log } = Apify.utils;

// Copied from https://github.com/metalwarrior665/apify-utils/blob/master/copy-paste/storage.js
// TODO: replace with a library version when it is created

/**
 * Loads items from one or many datasets in parallel by chunking the items from each dataset into batches,
 * retaining order of both items and datasets. Useful for large loads.
 * By default returns one array of items in order of datasets provided.
 * By changing concatItems or concatDatasets options, you can get array of arrays (of arrays) back
 * Requires bluebird dependency and copy calculateLocalOffsetLimit function!!!
 *
 * @param {string[]} datasetIds IDs or names of datasets you want to load
 * @param {object} options Options with default values.
 * If both concatItems and concatDatasets are false, output of this function is an array of datasets containing arrays
 * of batches containig array of items.
 * concatItems concats all batches of one dataset into one array of items.
 * concatDatasets concat all datasets into one array of batches
 * Using both concatItems and concatDatasets gives you back a sinlge array of all items in order.
 * Both are true by default.
 * @param {(items: any[], params: { datasetId: string, datasetOffset: number }) => Promise<void>} [options.processFn]
 *  Data are not returned by fed to the supplied async function on the fly (reduces memory usage)
 * @param {number} [options.parallelLoads]
 * @param {number} [options.batchSize]
 * @param {number} [options.offset=0]
 * @param {number} [options.limit=999999999]
 * @param {boolean} [options.concatItems]
 * @param {boolean} [options.concatDatasets]
 * @param {boolean} options.fields
 * @param {boolean} options.useLocalDataset Datasets will be always loaded from Apify could, even locally
 * @param {boolean} [options.debugLog]
 * @param {boolean} [options.persistLoadingStateForProcesFn=false]
 * @param {boolean} [options.appendDatasetIds=false]
 * Will not load batches that were already processed before migration, does nothing if processFn is not used.
 * It does not persist the state inside processFn, that is a responsibillity of the caller (if needed)
 * You must not manipulate input parameters (and underlying datasets) between migrations or this will break
 */
module.exports.loadDatasetItemsInParallel = async (datasetIds, options = {}) => {
    const {
        processFn,
        parallelLoads = 20,
        batchSize = 50000,
        offset = 0,
        limit = 999999999,
        concatItems = true,
        concatDatasets = true,
        debugLog = false,
        persistLoadingStateForProcesFn = false,
        fields,
        // Figure out better name since this is useful for datasets by name on platform
        useLocalDataset = false, // Will fetch/create datasets by id or name locally or on current account
        appendDatasetIds = false,
    } = options;

    if (useLocalDataset && !Apify.isAtHome() && fields) {
        log.warning('loadDatasetItemsInParallel - fields option does not work on local datasets');
    }

    const loadStart = Date.now();

    // Returns either null if offset/limit does not fit the current chunk
    // or { offset, limit } object
    const calculateLocalOffsetLimit = ({ offset, limit, localStart, batchSize }) => {
        const localEnd = localStart + batchSize;
        const inputEnd = offset + limit;

        // Offset starts after the current chunk
        if (offset >= localEnd) {
            return null;
        }
        // Offset + limit ends before our chunk
        if (inputEnd <= localStart) {
            return null;
        }

        // Now we know that the some data are in the current batch
        const calculateLimit = () => {
            // limit overflows current batch
            if (inputEnd >= localEnd) {
                // Now either the offset is less than local start and we do whole batch
                if (offset < localStart) {
                    return batchSize;
                }
                // Or it is inside the current batch and we slice it from the start (including whole batch)
                return localEnd - offset;
            } else { // Consider (inputEnd < localEnd) Means limit ends inside current batch
                if (offset < localStart) {
                    return inputEnd - localStart;
                }
                // This means both offset and limit are inside current batch
                return inputEnd - offset;
            }
        };

        return {
            offset: Math.max(localStart, offset),
            limit: calculateLimit(),
        };
    };

    // If we use processFnLoadingState, we skip requests that are done
    const createRequestArray = async (processFnLoadingState) => {
        // We increment for each dataset so we remember their order
        let datasetIndex = 0;

        // This array will be used to create promises to run in parallel
        const requestInfoArr = [];

        for (let datasetId of datasetIds) {
            // We get the number of items first and then we precreate request info objects
            let itemCount;
            if (useLocalDataset) {
                const dataset = await Apify.openDataset(datasetId);
                itemCount = await dataset.getInfo().then((res) => res.itemCount);
            } else {
                const datasetInfo = await Apify.newClient().dataset(datasetId).get();
                if (datasetInfo) {
                    itemCount = datasetInfo.itemCount;
                } else {
                    // We can be nice to users and check if they didn't accidentally use run ID
                    const runInfo = await Apify.newClient().run(datasetId).get();
                    if (runInfo) {
                        datasetId = runInfo.defaultDatasetId;
                        itemCount = await Apify.newClient().dataset(datasetId).get().then((res) => res.itemCount);
                    } else {
                        log.warning(`Dataset ${datasetId} does not exist, perhaps the run was already removed after data retention? Continuing...`);
                        continue;
                    }
                }
            }
            if (debugLog) {
                if (itemCount > 0) {
                    log.info(`Dataset ${datasetId} has ${itemCount} items`);
                } else {
                    log.warning(`Dataset ${datasetId} has 0 items, skipping`);
                }
            }
            if (itemCount === 0) {
                continue;
            }
            const numberOfBatches = Math.ceil(itemCount / batchSize);

            if (processFnLoadingState && !processFnLoadingState[datasetId]) {
                processFnLoadingState[datasetId] = {};
            }

            for (let i = 0; i < numberOfBatches; i++) {
                const localOffsetLimit = calculateLocalOffsetLimit({ offset, limit, localStart: i * batchSize, batchSize });
                if (!localOffsetLimit) {
                    continue;
                }

                if (processFnLoadingState) {
                    if (!processFnLoadingState[datasetId][localOffsetLimit.offset]) {
                        processFnLoadingState[datasetId][localOffsetLimit.offset] = { done: false };
                    } else if (processFnLoadingState[datasetId][localOffsetLimit.offset].done) {
                        log.info(`Batch for dataset ${datasetId}, offset: ${localOffsetLimit.offset} was already processed, skipping...`);
                        continue;
                    }
                }

                requestInfoArr.push({
                    index: i,
                    offset: localOffsetLimit.offset,
                    limit: localOffsetLimit.limit,
                    datasetId,
                    datasetIndex,
                });
            }

            datasetIndex++;
        }
        return requestInfoArr;
    };

    // This is array of arrays. Top level array is for each dataset and inside one entry for each batch (in order)
    /** @type {any[]} */
    let loadedBatchedArr = [];

    let totalLoaded = 0;
    const totalLoadedPerDataset = {};

    const processFnLoadingState = persistLoadingStateForProcesFn
        ? ((await Apify.getValue('PROCESS-FN-LOADING-STATE')) || {})
        : null;

    // Apify.events doesn't work because this is different Apify instance
    if (processFnLoadingState) {
        setInterval(async () => {
            await Apify.setValue('PROCESS-FN-LOADING-STATE', processFnLoadingState);
        }, 15000);
    }

    const requestInfoArr = await createRequestArray(processFnLoadingState);
    if (debugLog) {
        log.info(`Number of requests to do: ${requestInfoArr.length}`);
    }

    //  Now we execute all the requests in parallel (with defined concurrency)
    await bluebird.map(requestInfoArr, async (requestInfoObj) => {
        const { index, datasetId, datasetIndex } = requestInfoObj;

        const getDataOptions = {
            offset: requestInfoObj.offset,
            limit: requestInfoObj.limit,
            fields,
        };
        let items;
        if (useLocalDataset) {
            // This open should be cached
            const dataset = await Apify.openDataset(datasetId);

            if (!Apify.isAtHome()) {
                delete getDataOptions.fields;
            }
            items = await dataset.getData(getDataOptions)
                .then((res) => res.items);
        } else {
            items = await Apify.newClient().dataset(datasetId).listItems(getDataOptions)
                .then((res) => res.items);
        }

        if (appendDatasetIds) {
            for (const item of items) {
                // eslint-disable-next-line no-underscore-dangle
                item.__datasetId__ = datasetId;
            }
        }

        if (!totalLoadedPerDataset[datasetId]) {
            totalLoadedPerDataset[datasetId] = 0;
        }

        totalLoadedPerDataset[datasetId] += items.length;
        totalLoaded += items.length;

        if (debugLog) {
            log.info(
                `Items loaded from dataset ${datasetId}: ${items.length}, offset: ${requestInfoObj.offset}, `
                    + `total loaded from dataset ${datasetId}: ${totalLoadedPerDataset[datasetId]}, `
                    + `total loaded: ${totalLoaded}`,
            );
        }
        // We either collect the data or we process them on the fly
        if (processFn) {
            await processFn(items, { datasetId, datasetOffset: requestInfoObj.offset });
            if (processFnLoadingState) {
                processFnLoadingState[datasetId][requestInfoObj.offset].done = true;
            }
        } else {
            if (!loadedBatchedArr[datasetIndex]) {
                loadedBatchedArr[datasetIndex] = [];
            }
            // Now we correctly assign the items into the main array
            loadedBatchedArr[datasetIndex][index] = items;
        }
    }, { concurrency: parallelLoads });

    if (debugLog) {
        log.info(`Loading took ${Math.round((Date.now() - loadStart) / 1000)} seconds`);
    }

    if (processFnLoadingState) {
        await Apify.setValue('PROCESS-FN-LOADING-STATE', processFnLoadingState);
    }

    if (!processFn) {
        if (concatItems) {
            for (let i = 0; i < loadedBatchedArr.length; i++) {
                /**
                 * @param {any} item
                 */
                loadedBatchedArr[i] = loadedBatchedArr[i].flatMap((item) => item);
            }
        }

        if (concatDatasets) {
            loadedBatchedArr = loadedBatchedArr.flatMap((item) => item);
        }
        return loadedBatchedArr;
    }
};
