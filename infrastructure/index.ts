#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import {PipelineStack} from './lib/pipeline-stack';

import {config} from './config'


const app = new cdk.App();
new PipelineStack(app, 'CdkPipelineStarterKitStack', {
    githubRepositoryOwner: config.github.owner,
    githubRepositoryName: config.github.repository,
    env: {account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION},
});

app.synth()
