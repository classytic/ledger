import { describe, it, expect } from 'vitest';
import { Schema } from 'mongoose';
import { buildDimensionFields, buildDimensionIndexes } from '../../src/utils/dimensions.js';
import type { DimensionDefinition } from '../../src/utils/dimensions.js';

describe('buildDimensionFields', () => {
  it('generates correct schema for dimensions with refs', () => {
    const dims: DimensionDefinition[] = [
      { field: 'departmentId', label: 'Department', ref: 'Department' },
      { field: 'projectId', label: 'Project', ref: 'Project' },
    ];

    const fields = buildDimensionFields(dims);

    expect(fields).toHaveProperty('departmentId');
    expect(fields).toHaveProperty('projectId');

    const dept = fields.departmentId as Record<string, unknown>;
    expect(dept.type).toBe(Schema.Types.ObjectId);
    expect(dept.ref).toBe('Department');
    expect(dept.required).toBe(false);
    expect(dept.default).toBeNull();

    const proj = fields.projectId as Record<string, unknown>;
    expect(proj.type).toBe(Schema.Types.ObjectId);
    expect(proj.ref).toBe('Project');
    expect(proj.required).toBe(false);
    expect(proj.default).toBeNull();
  });

  it('handles required flag', () => {
    const dims: DimensionDefinition[] = [
      { field: 'costCenterId', label: 'Cost Center', ref: 'CostCenter', required: true },
      { field: 'projectId', label: 'Project', ref: 'Project', required: false },
      { field: 'regionId', label: 'Region', ref: 'Region' }, // default false
    ];

    const fields = buildDimensionFields(dims);

    expect((fields.costCenterId as Record<string, unknown>).required).toBe(true);
    expect((fields.projectId as Record<string, unknown>).required).toBe(false);
    expect((fields.regionId as Record<string, unknown>).required).toBe(false);
  });

  it('omits ref when not provided', () => {
    const dims: DimensionDefinition[] = [
      { field: 'tagId', label: 'Tag' },
    ];

    const fields = buildDimensionFields(dims);
    const tag = fields.tagId as Record<string, unknown>;

    expect(tag.type).toBe(Schema.Types.ObjectId);
    expect(tag).not.toHaveProperty('ref');
  });

  it('returns empty object for empty dimensions', () => {
    expect(buildDimensionFields([])).toEqual({});
  });
});

describe('buildDimensionIndexes', () => {
  it('generates indexes with orgField', () => {
    const dims: DimensionDefinition[] = [
      { field: 'departmentId', label: 'Department', ref: 'Department' },
      { field: 'projectId', label: 'Project', ref: 'Project' },
    ];

    const indexes = buildDimensionIndexes(dims, 'business');

    expect(indexes).toHaveLength(2);

    expect(indexes[0].fields).toEqual({
      business: 1,
      'journalItems.departmentId': 1,
      date: -1,
    });
    expect(indexes[0].options).toEqual({});

    expect(indexes[1].fields).toEqual({
      business: 1,
      'journalItems.projectId': 1,
      date: -1,
    });
  });

  it('generates indexes without orgField', () => {
    const dims: DimensionDefinition[] = [
      { field: 'departmentId', label: 'Department', ref: 'Department' },
    ];

    const indexes = buildDimensionIndexes(dims);

    expect(indexes).toHaveLength(1);
    expect(indexes[0].fields).toEqual({
      'journalItems.departmentId': 1,
      date: -1,
    });
    // Should NOT have an org field key
    expect(indexes[0].fields).not.toHaveProperty('business');
  });

  it('returns empty array for empty dimensions', () => {
    expect(buildDimensionIndexes([])).toEqual([]);
  });
});
