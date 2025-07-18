<?php

/*
 * Copyright (C) 2015-2022 Franco Fichtner <franco@opnsense.org>
 * Copyright (C) 2009 Erik Kristensen <erik@erikkristensen.com>
 * Copyright (C) 2004-2010 Scott Ullrich <sullrich@gmail.com>
 * Copyright (C) 2003-2004 Manuel Kasper <mk@neon1.net>
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES,
 * INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
 * AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
 * OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

final class product
{
    private static $instance = null;
    private static $data = null;

    public static function getInstance(): product
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }

        return self::$instance;
    }

    private function __construct()
    {
        self::$data = json_decode(file_get_contents('/usr/local/opnsense/version/core'), true);

        /* boot detection */
        self::$data['product_booting'] = false;
        $fp = fopen('/var/run/booting', 'a+e');
        if ($fp) {
            self::$data['product_booting'] = !flock($fp, LOCK_SH | LOCK_NB);
            fclose($fp);
        }

        /* development flag */
        $develflag = '/var/run/development';
        self::$data['product_development'] = file_exists($develflag);
    }

    private function __clone()
    {
    }

    public function __wakeup()
    {
        throw new Exception('Cannot unserialize singleton');
    }

    public function __call($name, $arguments)
    {
        if (!empty(self::$data['product_' . $name])) {
            return self::$data['product_' . $name];
        }
    }
}

function listtags()
{
    /* The following items will be treated as arrays in config.xml */
    $ret = [
      'acls', 'alias', 'aliasurl', 'allowedip', 'allowedhostname', 'authserver',
      'bridged', 'build_port_path',
      'ca', 'cacert', 'cert', 'crl', 'clone', 'config', 'container', 'columnitem',
      'dhcp_ranges', 'disk', 'dnsserver', 'dnsupdate', 'domainoverrides',
      'element', 'encryption-algorithm-option',
      'field', 'fieldname',
      'gateway_item', 'gateway_group', 'gif', 'gre', 'group',
      'hash-algorithm-option', 'hosts',
      'ifgroupentry', 'igmpentry', 'interface_array', 'item',
      'key',
      'lagg', 'lbpool',
      'member', 'menu', 'mobilekey', 'monitor_type', 'mount',
      'npt', 'ntpserver',
      'onetoone', 'openvpn-server', 'openvpn-client', 'openvpn-csc', 'option',
      'package', 'passthrumac', 'phase1', 'phase2', 'ppp', 'pppoe', 'priv', 'proxyarpnet', 'pool', 'pages', 'pipe',
      'radnsserver', 'roll', 'route', 'row', 'rrddatafile', 'rule',
      'schedule', 'service', 'servernat', 'servers', 'serversdisabled', 'staticmap', 'subqueue',
      'tab', 'timerange', 'tunnel',
      'user',
      'vip', 'virtual_server', 'vlan',
      'winsserver', 'wolentry', 'widget',
    ];

    return array_flip($ret);
}

function reopenlog()
{
    openlog(product::getInstance()->id(), LOG_ODELAY, LOG_USER);
}

reopenlog();

require_once("legacy_bindings.inc");
require_once("certs.inc");

/*
 * Hook up the plugin system which consists of several low-profile
 * functions that can be called from within our backend code when
 * they exist.
 */
require_once('plugins.inc');

/**
 * parse config into array and return
 */
function load_config_from_file($filename)
{
    return OPNsense\Core\Config::getInstance()->toArrayFromFile($filename, listtags());
}

/****f* config/parse_config
 * NAME
 *   parse_config - Read in config.xml if needed and return $config array
 * RESULT
 *   $config      - array containing all configuration variables
 ******/
function parse_config()
{
    $cnf = OPNsense\Core\Config::getInstance();
    /* make sure to write back global variable */
    $config = $cnf->toArray(listtags());
    return $config;
}

/****f* config/convert_config
 * NAME
 *   convert_config - Attempt to update config.xml.
 * DESCRIPTION
 *   convert_config() reads the current global configuration
 *   and attempts to convert it to conform to the latest
 *   config.xml version. This allows major formatting changes
 *   to be made with a minimum of breakage.
 * RESULT
 *   null
 ******/
/* convert configuration, if necessary */
function convert_config($verbose = false)
{
    global $config;

    if (!isset($config['revision'])) {
        /* force a revision tag for proper handling in config history */
        write_config('Factory configuration', false);
    }

    /* chain the new migration into this function call */
    $cmd = '/usr/local/opnsense/mvc/script/run_migrations.php';
    if ($verbose) {
        passthru($cmd);
    } else {
        mwexecf($cmd);
    }

    /* register pluggable interfaces */
    $cmd = '/usr/local/sbin/pluginctl -i';
    if ($verbose) {
        passthru($cmd);
    } else {
        mwexecf($cmd);
    }

    /* factory reset on release type and plugins if necessary */
    $cmd = '/usr/local/opnsense/scripts/firmware/register.php sync';
    if ($verbose) {
        passthru($cmd);
    } else {
        mwexecf($cmd);
    }

    /* reload the config as it was rewritten and saved in the script context */
    OPNsense\Core\Config::getInstance()->forceReload();
    $config = parse_config();
}

/****f* config/write_config
 * NAME
 *   write_config - Backup and write the firewall configuration.
 * DESCRIPTION
 *   write_config() handles backing up the current configuration,
 *   applying changes, and regenerating the configuration cache.
 * INPUTS
 *   $desc  - string containing the a description of configuration changes
 *   $backup  - boolean: do not back up current configuration if false.
 * RESULT
 *   null
 ******/
/* save the system configuration */
function write_config($desc = '', $backup = true)
{
    global $config;

    if (!empty($_SERVER['REMOTE_ADDR'])) {
        if (!empty($_SESSION['Username']) && ($_SESSION['Username'] != 'root')) {
            $user = getUserEntry($_SESSION['Username']);
            if (is_array($user) && userHasPrivilege($user, "user-config-readonly")) {
                // okay, it's not very nice to check permissions here, but let's make it explicit while we do...
                syslog(LOG_ERR, "WARNING: User {$_SESSION['Username']} may not write config (user-config-readonly set)");
                return false;
            }
        }
    }

    /**
     * XXX: Temporary construction.
     *      When called via a legacy interface configure page, we might want to register new interfaces, but
     *      in cases we just want to save our changes (not related to interfaces), we risk raising errors for
     *      missing imports.
     *      Eventually relevant callers should call 'interface invoke registration', which is the same as
     *      mvc components use now (but can't be called here without side effects)
     */
    try {
        plugins_interfaces();
    } catch (Throwable $e) {
        null;
    }

    $cnf = OPNsense\Core\Config::getInstance();
    $cnf->fromArray($config);
    $revision_info = make_config_revision_entry($desc);

    try {
        $cnf->save($revision_info, $backup);
    } catch (OPNsense\Core\ConfigException $e) {
        // write failure
        syslog(LOG_ERR, 'WARNING: Config contents could not be saved. Could not open file!');
        return -1;
    }

    /* on successful save, serialize config back to global */
    $config = $cnf->toArray(listtags());

    return $config;
}

function &config_read_array()
{
    global $config;

    $current = &$config;

    foreach (func_get_args() as $key) {
        if (!isset($current[$key]) || !is_array($current[$key])) {
            $current[$key] = [];
        }
        $current = &$current[$key];
    }

    return $current;
}

function make_config_revision_entry($desc = '')
{
    if (!empty($_SESSION['Username'])) {
        $username = $_SESSION['Username'];
    } else {
        $username = '(' . shell_safe('/usr/bin/whoami') . ')';
    }

    if (!empty($_SERVER['REMOTE_ADDR'])) {
        $username .= '@' . $_SERVER['REMOTE_ADDR'];
    }

    if (empty($desc)) {
        $desc = sprintf('%s made changes', $_SERVER['SCRIPT_NAME']);
    }

    $revision = [];
    $revision['username'] = $username;
    $revision['time'] = sprintf('%0.2f', microtime(true));
    $revision['description'] = $desc;

    return $revision;
}

/**
 * find list of registered interfaces
 * @param array $filters list of filters to apply
 * @return array interfaces
 */
function legacy_config_get_interfaces($filters = [], $exclude_ifs = [])
{
    $interfaces = [];

    foreach (config_read_array('interfaces') as $ifname => $iface) {
        if (in_array($ifname, $exclude_ifs)) {
            continue;
        }

        // undo stupid listtags() turning our item into a new array, preventing certain names to be used as interface
        if (isset($iface[0])) {
            $iface = $iface[0];
        }

        // apply filters
        $iface_match = true;
        foreach ($filters as $filter_key => $filter_value) {
            if ($filter_key == 'enable' && isset($iface[$filter_key])) {
                $field_value = true;
            } else {
                $field_value = isset($iface[$filter_key]) ? $iface[$filter_key] : false;
            }
            if ($field_value != $filter_value) {
                $iface_match = false;
                break;
            }
        }

        if ($iface_match && !empty($iface)) {
            $iface['descr'] = !empty($iface['descr']) ? $iface['descr'] : strtoupper($ifname);
            $iface['ipaddrv6'] = !empty($iface['ipaddrv6']) ? $iface['ipaddrv6'] : null;
            $iface['ipaddr'] = !empty($iface['ipaddr']) ? $iface['ipaddr'] : null;
            $interfaces[$ifname] = $iface;
        }
    }

    uasort($interfaces, function ($a, $b) {
        return strnatcmp($a['descr'], $b['descr']);
    });

    return $interfaces;
}

/**
 * legacy helper to generate a uuid in a similar fashion as the model code would.
 */
function generate_uuid()
{
    return sprintf(
        '%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
        random_int(0, 0xffff),
        random_int(0, 0xffff),
        random_int(0, 0xffff),
        random_int(0, 0x0fff) | 0x4000,
        random_int(0, 0x3fff) | 0x8000,
        random_int(0, 0xffff),
        random_int(0, 0xffff),
        random_int(0, 0xffff)
    );
}

/**
 * parse stored json content, return empty when not found or expired
 */
function get_cached_json_content($filename, $ttl = 3600)
{
    $result = null;
    if (file_exists($filename)) {
        $fstat = stat($filename);
        if ((time() - $fstat['mtime']) < $ttl) {
            $result = json_decode(file_get_contents($filename), true);
        }
    }
    return $result;
}

$config = parse_config();

/* set timezone */
$timezone = $config['system']['timezone'];
if (!$timezone) {
    $timezone = 'Etc/UTC';
}

date_default_timezone_set($timezone);
