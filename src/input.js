const { MODES } = require('./consts');

const { DEDUP_AFTER_LOAD, DEDUP_AS_LOADING } = MODES;

module.exports.validateInput = ({ datasetIds, actorOrTaskId, output, mode, outputTo, preDedupTransformFunction, postDedupTransformFunction}) => {
    if (!(Array.isArray(datasetIds) && datasetIds.length > 0) && !actorOrTaskId) {
        throw new Error('WRONG INPUT --- Missing datasetIds or actorIdOrName!');
    }

    if (!['unique-items', 'duplicate-items', 'nothing'].includes(output)) {
        throw new Error('WRONG INPUT --- output has to be one of ["unique-items", "duplicate-items", "nothing"]');
    }

    if (![DEDUP_AFTER_LOAD, DEDUP_AS_LOADING].includes(mode)) {
        throw new Error('WRONG INPUT --- mode has to be one of ["dedup-after-load", "dedup-as-loading"]');
    }

    if (!['dataset', 'key-value-store'].includes(outputTo)) {
        throw new Error('WRONG INPUT --- outputTo has to be one of ["dataset", "key-value-store"]');
    }

    try {
        const evaledPre = eval(preDedupTransformFunction);
        if (typeof evaledPre !== 'function') {
            throw new Error('WRONG INPUT --- preDedupTransformFunction is not a JS function!');
        }
    } catch (_e) {
        throw new Error('WRONG INPUT --- preDedupTransformFunction is not a valid JavaScript');
    }

    try {
        const evaledPost = eval(postDedupTransformFunction);
        if (typeof evaledPost !== 'function') {
            throw new Error('WRONG INPUT --- postDedupTransformFunction is not a JS function!');
        }
    } catch (_e) {
        throw new Error('WRONG INPUT --- postDedupTransformFunction is not a valid JavaScript');
    }
};
