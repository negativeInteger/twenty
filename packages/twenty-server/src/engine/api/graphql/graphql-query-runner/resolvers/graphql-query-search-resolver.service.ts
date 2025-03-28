import { Injectable } from '@nestjs/common';

import { Brackets } from 'typeorm';
import { isDefined } from 'twenty-shared/utils';

import {
  GraphqlQueryBaseResolverService,
  GraphqlQueryResolverExecutionArgs,
} from 'src/engine/api/graphql/graphql-query-runner/interfaces/base-resolver-service';
import {
  ObjectRecord,
  ObjectRecordFilter,
  OrderByDirection,
} from 'src/engine/api/graphql/workspace-query-builder/interfaces/object-record.interface';
import { IConnection } from 'src/engine/api/graphql/workspace-query-runner/interfaces/connection.interface';
import { WorkspaceQueryRunnerOptions } from 'src/engine/api/graphql/workspace-query-runner/interfaces/query-runner-option.interface';
import { SearchResolverArgs } from 'src/engine/api/graphql/workspace-resolver-builder/interfaces/workspace-resolvers-builder.interface';

import { QUERY_MAX_RECORDS } from 'src/engine/api/graphql/graphql-query-runner/constants/query-max-records.constant';
import { ObjectRecordsToGraphqlConnectionHelper } from 'src/engine/api/graphql/graphql-query-runner/helpers/object-records-to-graphql-connection.helper';
import { FeatureFlagKey } from 'src/engine/core-modules/feature-flag/enums/feature-flag-key.enum';
import { formatSearchTerms } from 'src/engine/core-modules/global-search/utils/format-search-terms';
import { SEARCH_VECTOR_FIELD } from 'src/engine/metadata-modules/constants/search-vector-field.constants';
import { formatResult } from 'src/engine/twenty-orm/utils/format-result.util';

@Injectable()
export class GraphqlQuerySearchResolverService extends GraphqlQueryBaseResolverService<
  SearchResolverArgs,
  IConnection<ObjectRecord>
> {
  async resolve(
    executionArgs: GraphqlQueryResolverExecutionArgs<SearchResolverArgs>,
    featureFlagsMap: Record<FeatureFlagKey, boolean>,
  ): Promise<IConnection<ObjectRecord>> {
    const { authContext, objectMetadataMaps, objectMetadataItemWithFieldMaps } =
      executionArgs.options;

    const typeORMObjectRecordsParser =
      new ObjectRecordsToGraphqlConnectionHelper(
        objectMetadataMaps,
        featureFlagsMap,
      );

    if (!isDefined(executionArgs.args.searchInput)) {
      return typeORMObjectRecordsParser.createConnection({
        objectRecords: [],
        objectName: objectMetadataItemWithFieldMaps.nameSingular,
        take: 0,
        totalCount: 0,
        order: [{ id: OrderByDirection.AscNullsFirst }],
        hasNextPage: false,
        hasPreviousPage: false,
      });
    }

    const searchTerms = formatSearchTerms(
      executionArgs.args.searchInput,
      'and',
    );
    const searchTermsOr = formatSearchTerms(
      executionArgs.args.searchInput,
      'or',
    );

    const limit = executionArgs.args?.limit ?? QUERY_MAX_RECORDS;

    const queryBuilder = executionArgs.repository.createQueryBuilder(
      objectMetadataItemWithFieldMaps.nameSingular,
    );

    executionArgs.graphqlQueryParser.applyFilterToBuilder(
      queryBuilder,
      objectMetadataItemWithFieldMaps.nameSingular,
      executionArgs.args.filter ?? ({} as ObjectRecordFilter),
    );

    const countQueryBuilder = queryBuilder.clone();

    const resultsQueryBuilder =
      searchTerms !== ''
        ? queryBuilder
            .andWhere(
              new Brackets((qb) => {
                qb.where(
                  `"${SEARCH_VECTOR_FIELD.name}" @@ to_tsquery('simple', :searchTerms)`,
                  { searchTerms },
                ).orWhere(
                  `"${SEARCH_VECTOR_FIELD.name}" @@ to_tsquery('simple', :searchTermsOr)`,
                  { searchTermsOr },
                );
              }),
            )
            .orderBy(
              `ts_rank_cd("${SEARCH_VECTOR_FIELD.name}", to_tsquery(:searchTerms))`,
              'DESC',
            )
            .addOrderBy(
              `ts_rank("${SEARCH_VECTOR_FIELD.name}", to_tsquery(:searchTermsOr))`,
              'DESC',
            )
            .setParameter('searchTerms', searchTerms)
            .setParameter('searchTermsOr', searchTermsOr)
            .take(limit)
        : queryBuilder
            .andWhere(
              new Brackets((qb) => {
                qb.where(`"${SEARCH_VECTOR_FIELD.name}" IS NOT NULL`);
              }),
            )
            .take(limit);

    const resultsWithTsVector =
      (await resultsQueryBuilder.getMany()) as ObjectRecord[];

    const objectRecords = formatResult<ObjectRecord[]>(
      resultsWithTsVector,
      objectMetadataItemWithFieldMaps,
      objectMetadataMaps,
    );

    const totalCount = isDefined(
      executionArgs.graphqlQuerySelectedFieldsResult.aggregate.totalCount,
    )
      ? await countQueryBuilder.getCount()
      : 0;
    const order = undefined;

    if (executionArgs.graphqlQuerySelectedFieldsResult.relations) {
      await this.processNestedRelationsHelper.processNestedRelations({
        objectMetadataMaps,
        parentObjectMetadataItem: objectMetadataItemWithFieldMaps,
        parentObjectRecords: objectRecords,
        relations: executionArgs.graphqlQuerySelectedFieldsResult.relations,
        aggregate: executionArgs.graphqlQuerySelectedFieldsResult.aggregate,
        limit,
        authContext,
        dataSource: executionArgs.dataSource,
        isNewRelationEnabled:
          featureFlagsMap[FeatureFlagKey.IsNewRelationEnabled],
      });
    }

    return typeORMObjectRecordsParser.createConnection({
      objectRecords: objectRecords ?? [],
      objectName: objectMetadataItemWithFieldMaps.nameSingular,
      take: limit,
      totalCount,
      order,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  }

  async validate(
    _args: SearchResolverArgs,
    _options: WorkspaceQueryRunnerOptions,
  ): Promise<void> {}
}
