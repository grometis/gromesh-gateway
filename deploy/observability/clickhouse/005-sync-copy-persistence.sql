ALTER TABLE gromesh.requests_v2_copies MODIFY SETTING fsync_after_insert = 1, fsync_part_directory = 1, min_rows_to_fsync_after_merge = 1;
