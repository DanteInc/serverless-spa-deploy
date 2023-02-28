'use strict';

const _ = require('lodash');
const glob = require('glob-all');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const mime = require('mime-types');

class Plugin {
  constructor(serverless, options) {

    this.commands = {
      spaDeploy: {
        lifecycleEvents: [
          'deploy'
        ]
      },
      spaRemoveObjects: {
        lifecycleEvents: [
          'remove'
        ]
      },
      spaRemoveVersions: {
        lifecycleEvents: [
          'remove'
        ]
      },
    };

    this.hooks = {
      'after:deploy:deploy': deploy.bind(null, serverless, options),
      'before:remove:remove': removeVersions.bind(null, serverless, options),
      'spaDeploy:deploy': deploy.bind(null, serverless, options),
      'spaRemoveObjects:remove': removeObjects.bind(null, serverless, options),
      'spaRemoveVersions:remove': removeVersions.bind(null, serverless, options)
    };
  }
}

module.exports = Plugin;

const DEFAULT_FILES = {
  source: './build',
  globs: '**/*', // index.html
  defaultContentType: 'application/octet-stream',
  headers: {
    // CacheControl: 'max-age=300' // 5 minutes
    // CacheControl: 'max-age=86400' // 1 day
    // CacheControl: 'max-age=31536000' // 1 year
  }
};

const deploy = (serverless) => {
  const config = Object.assign(
    {},
    { // defaults
      websiteBucketNameOutputRef: 'WebsiteBucketName',
      prefix: '',
      acl: 'private',
      gzip: ['js', 'map'],
      files: [
        DEFAULT_FILES,
      ]
    },
    (serverless.service.custom && serverless.service.custom.spa) || {}
  );
  // console.log('config: %j', config);

  return Promise.resolve()
    .then(() => getWebsiteBucketName(serverless, config))
    .then((websiteBucketName) => {
      // console.log('websiteBucketName: %j', websiteBucketName);

      return Promise.all(
        config.files.map((files) => {
          const opt = Object.assign({}, DEFAULT_FILES, files);

          serverless.cli.log(`Path: ${opt.source}`);

          return Promise.all(
            glob.sync(opt.globs, { nodir: true, cwd: opt.source })
              .map((filename) => {
                const body = fs.readFileSync(path.join(opt.source, filename));
                const type = opt.headers.ContentType || mime.lookup(filename) || opt.defaultContentType;
                const key = opt.key || path.posix.join(config.prefix, filename);

                serverless.cli.log(`File: ${filename} (${type})`);

                const params = Object.assign({
                  ACL: config.acl,
                  Body: config.gzip?.includes(type) ? zlib.gzipSync(body) : body,
                  Bucket: websiteBucketName,
                  Key: key,
                  ContentType: type,
                  ContentEncoding: config.gzip?.includes(type) ? 'gzip' : undefined,
                }, opt.headers);

                // console.log('params: %j', _.omit(params, 'Body'));

                return serverless.getProvider('aws').request('S3', 'putObject', params);
              })
          );
        })
      );
    });
};

const removeObjects = (serverless) => {
  const config = Object.assign(
    {},
    {
      websiteBucketNameOutputRef: 'WebsiteBucketName',
    },
    (serverless.service.custom && serverless.service.custom.spa) || {}
  );

  return Promise.resolve()
    .then(() => getWebsiteBucketName(serverless, config))
    .then((websiteBucketName) => {
      // console.log('websiteBucketName: %j', websiteBucketName);

      const removeObjects = (nextContinuationToken) => {
        const params = {
          Bucket: websiteBucketName,
          // MaxKeys: 3, // to test recursion
          ContinuationToken: nextContinuationToken,
        };

        const provider = serverless.getProvider('aws');

        return provider.request('S3', 'listObjectsV2', params)
          .then((data) => {
            return {
              nextContinuationToken: data.NextContinuationToken,
              params: data.Contents.reduce(
                (params, current) => {
                  params.Delete.Objects.push({
                    Key: current.Key
                  });
                  return params;
                },
                {
                  Bucket: websiteBucketName,
                  Delete: {
                    Objects: []
                  }
                }
              ),
            };
          })
          .then((uow) => {
            // console.log('uow: %j', uow);

            if (uow.params.Delete.Objects.length > 0) {
              return provider.request('S3', 'deleteObjects', uow.params)
                .then((data) => {
                  data.Deleted.forEach((file) => serverless.cli.log(`Removed: ${file.Key}`));

                  // recurse
                  if (uow.nextContinuationToken) {
                    // console.log('nextContinuationToken: %j', uow.nextContinuationToken);
                    return removeObjects(uow.nextContinuationToken);
                  }
                });
            }
          });
      };

      return removeObjects();
    });
};

const removeVersions = (serverless) => {
  const config = Object.assign(
    {},
    {
      websiteBucketNameOutputRef: 'WebsiteBucketName',
    },
    (serverless.service.custom && serverless.service.custom.spa) || {}
  );

  return Promise.resolve()
    .then(() => getWebsiteBucketName(serverless, config))
    .then((websiteBucketName) => {
      // console.log('websiteBucketName: %j', websiteBucketName);

      const removeVersions = (nextKeyMarker, nextVersionIdMarker) => {
        const params = {
          Bucket: websiteBucketName,
          MaxKeys: 500,
          KeyMarker: nextKeyMarker,
          VersionIdMarker: nextVersionIdMarker
        };

        const provider = serverless.getProvider('aws');

        return provider.request('S3', 'listObjectVersions', params)
          .then((data) => {
            let params = data.Versions.reduce(
              (params, current) => {
                params.Delete.Objects.push({
                  Key: current.Key,
                  VersionId: current.VersionId
                });
                return params;
              },
              {
                Bucket: websiteBucketName,
                Delete: {
                  Objects: []
                }
              }
            );

            params = data.DeleteMarkers.reduce((params, current) => {
              params.Delete.Objects.push({
                Key: current.Key,
                VersionId: current.VersionId
              });
              return params;
            }, params);

            return {
              nextKeyMarker: data.NextKeyMarker,
              nextVersionIdMarker: data.NextVersionIdMarker,
              params: params,
            };
          })
          .then((uow) => {
            // console.log('uow: %j', uow);

            if (uow.params.Delete.Objects.length > 0) {
              return provider.request('S3', 'deleteObjects', uow.params)
                .then((data) => {
                  data.Deleted.forEach((file) => serverless.cli.log(`Removed: ${file.Key} - ${file.VersionId}`));

                  // recurse
                  if (uow.nextKeyMarker || uow.nextVersionIdMarker) {
                    // console.log('nextKeyMarker: %j', uow.nextKeyMarker);
                    // console.log('nextVersionIdMarker: %j', uow.nextVersionIdMarker);
                    return removeVersions(uow.nextKeyMarker, uow.nextVersionIdMarker);
                  }
                });
            }
          });
      };

      return removeVersions();
    });
};

const getWebsiteBucketName = (serverless, config) => {
  const awsInfo = _.find(serverless.pluginManager.getPlugins(), (plugin) => {
    return plugin.constructor.name === 'AwsInfo';
  });

  if (!awsInfo) {
    return;
  }

  return Promise.resolve()
    .then(() => {
      if (!awsInfo.gatheredData) {
        return awsInfo.getStackInfo();
      }
    })
    .then(() => {
      const outputs = awsInfo.gatheredData.outputs;

      const websiteBucketName = _.find(outputs, (output) => {
        return output.OutputKey === config.websiteBucketNameOutputRef;
      });

      if (!websiteBucketName || !websiteBucketName.OutputValue) {
        return;
      }

      return websiteBucketName.OutputValue;
    });
};
