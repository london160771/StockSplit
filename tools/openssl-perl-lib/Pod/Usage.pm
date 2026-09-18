package Pod::Usage;

use strict;
use warnings;

sub import {
    my ($class, @symbols) = @_;
    my $caller = caller;
    no strict 'refs';
    *{"${caller}::pod2usage"} = \&pod2usage;
}

sub pod2usage {
    die "pod2usage is unavailable in this non-interactive OpenSSL build\n";
}

1;
