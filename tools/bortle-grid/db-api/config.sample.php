<?php
// config.php -- database credentials and upload secret for the Bortle API.
// COPY config.sample.php to config.php and fill in real values.
// config.php is gitignored and must never be committed.
return [
  'db_host' => 'mysql.example.dreamhost.com',
  'db_name' => 'stargazer',
  'db_user' => 'stargazer',
  'db_pass' => 'CHANGEME',
  // Shared secret for upload_chunk.php. Generate with: openssl rand -hex 32
  'upload_secret' => 'CHANGEME',
];
