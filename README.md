# serverless-spa-deploy

Serverless plugin to deploy a single page app to an S3 bucket

* Uploads files to bucket after deploy
* Infers bucket name
  * Assumes a single bucket per app
* Empties bucket before stack remove
  * Supports versioned bucket
* Supports CacheControl header

## Default Configuration
```
custom:
  spa:
    websiteBucketNameOutputRef: WebsiteBucketName
    prefix: ''
    acl: public-read
    files:
      - source: ./build
        globs: '**/*'
```

## Typical Configuration
```
custom:
  spa:
    files:
      - globs: '**/*'
        headers:
          CacheControl: public,max-age=31536000,immutable # 1 year or more
      - globs: 'index.html'
        headers:
          CacheControl: max-age=300 # 5 minutes
```
