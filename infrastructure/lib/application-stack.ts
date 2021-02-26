import {Stack, Tags, Construct, StackProps} from '@aws-cdk/core';
import {Effect, PolicyDocument} from "@aws-cdk/aws-iam";
import {Protocol, SubnetType} from "@aws-cdk/aws-ec2";
import ec2 = require('@aws-cdk/aws-ec2');
import ds = require('@aws-cdk/aws-directoryservice');
import ssm = require('@aws-cdk/aws-ssm');
import iam = require('@aws-cdk/aws-iam');
import filesystem = require('@aws-cdk/aws-fsx');

export class ApplicationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    //<editor-fold desc="Amazon VPC Definition">
    const jdVPC = new ec2.Vpc(this, 'JdVPC');

    const selection = jdVPC.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE
    });
    let jdPrivateSubnetIds = [];
    for (const subnet of selection.subnets) {
      jdPrivateSubnetIds.push(subnet.subnetId);
    }
    //</editor-fold>

    //<editor-fold desc="Microsoft Active Directory">
    const jdAD = new ds.CfnMicrosoftAD(this, 'JdAD', {
      name: 'ad.chris.de',
      password: 'qn.GgEeD6tZ!X-9UMfk',
      vpcSettings: {
        subnetIds: jdPrivateSubnetIds,
        vpcId: jdVPC.vpcId,
      },
      edition: 'Standard'
    });

    const dhcpOptions = new ec2.CfnDHCPOptions(this, 'JdDhcpOptions', {
      domainName: jdAD.name
    })

    new ec2.CfnVPCDHCPOptionsAssociation(this, 'JdDhcpOptionsAssociation', {
      dhcpOptionsId: dhcpOptions.ref,
      vpcId: jdVPC.vpcId
    })
    //</editor-fold>

    //<editor-fold desc="Amazon FSx for Windows File Server">
    const jdSgFSx = new ec2.SecurityGroup(this, `sg-${id}`, {
      vpc: jdVPC,
      allowAllOutbound: true,
      securityGroupName: 'sgFSx',
      description: 'Security group of the FSx'
    });

    const jdFsx = new filesystem.CfnFileSystem(this, `${id}`, {
      fileSystemType: 'WINDOWS',
      subnetIds: [jdPrivateSubnetIds[0]],
      windowsConfiguration: {
        activeDirectoryId: jdAD.ref,
        throughputCapacity: 8,
        deploymentType: 'SINGLE_AZ_1',
        preferredSubnetId: jdPrivateSubnetIds[0]
      },
      securityGroupIds: [jdSgFSx.securityGroupId],
      storageCapacity: 32
    });
    //</editor-fold>

    //<editor-fold desc="Amazon Systems Manager for Automation and Governance">
    const ssmInstanceProfileRole = new iam.Role(this, 'jdSSMInstanceProfileRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMDirectoryServiceAccess')
      ],
      inlinePolicies: {
        'SSMCreateAssociation': new PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["ssm:CreateAssociation"],
              resources: ["*"]
            })
          ]
        })
      }
    });
    new iam.CfnInstanceProfile(this, 'jdSSMInstanceProfile', {
      roles: [ssmInstanceProfileRole.roleName]
    });

    const storedFSxResId = new ssm.StringParameter(this, 'fsx-resource-id', {
      stringValue: jdFsx.ref
    });
    // Grant read access to some Role
    storedFSxResId.grantRead(ssmInstanceProfileRole);

    // noinspection JSUnusedLocalSymbols
    const ssmServiceRole = new iam.Role(this, 'jdSSMServiceRole', {
      assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonSSMAutomationRole')],
      inlinePolicies: {
        'jdSSMServiceRolePolicy': new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                "iam:CreateInstanceProfile",
                "iam:ListInstanceProfilesForRole",
                "iam:PassRole",
                "ec2:DescribeIamInstanceProfileAssociations",
                "iam:GetInstanceProfile",
                "ec2:DisassociateIamInstanceProfile",
                "ec2:AssociateIamInstanceProfile",
                "iam:AddRoleToInstanceProfile"
              ],
              resources: ["*"]
            })
          ]
        })
      }
    });
    //</editor-fold>

    //<editor-fold desc="Admin and Control Server">
    const sgControlServerJd = new ec2.SecurityGroup(this, 'sg-ControlServer-Jd', {
      vpc: jdVPC,
      allowAllOutbound: true,
      securityGroupName: 'sgControlServerJd',
      description: 'Security group of the ControlServer'
    });
    sgControlServerJd.addIngressRule(ec2.Peer.anyIpv4(),
        new ec2.Port({
          protocol: Protocol.TCP,
          fromPort: 22,
          toPort: 22,
          stringRepresentation: 'allow ssh access from any ipv4 ip'
        })
    );
    sgControlServerJd.addIngressRule(ec2.Peer.anyIpv4(),
        new ec2.Port({
          protocol: Protocol.TCP,
          fromPort: 3389,
          toPort: 3389,
          stringRepresentation: 'allow rdp access from any ipv4 ip'
        })
    );

    jdSgFSx.connections.allowFrom(sgControlServerJd, ec2.Port.tcp(445), 'SMB for FSx');
    jdSgFSx.connections.allowFrom(sgControlServerJd, ec2.Port.udp(445), 'SMB for FSx');
    jdSgFSx.connections.allowFrom(sgControlServerJd, ec2.Port.tcpRange(1024, 65535), 'Ephemeral ports for RPC for FSx');
    jdSgFSx.connections.allowFrom(sgControlServerJd, ec2.Port.tcp(135), 'RPC for FSx');
    jdSgFSx.connections.allowFrom(sgControlServerJd, ec2.Port.udpRange(1024, 65535), 'Ephemeral ports for RPC for FSx');

    const controlServerUserData = ec2.UserData.forWindows();
    controlServerUserData.addCommands('Install-windowsfeature -name AD-Domain-Services -IncludeManagementTools');
    controlServerUserData.addCommands(`Set-DefaultAWSRegion -Region eu-central-1`);
    controlServerUserData.addCommands(`Set-Variable -name instance_id -value (Invoke-Restmethod -uri http://169.254.169.254/latest/meta-data/instance-id)`);
    // controlServerUserData.addCommands(`New-SSMAssociation -InstanceId $instance_id -Name ${ssmDocs.joinAD.name}`);

    const jdWindowImage = new ec2.WindowsImage(ec2.WindowsVersion.WINDOWS_SERVER_2019_ENGLISH_FULL_BASE, {});

    const jdInstance = new ec2.Instance(this, 'jdControlServer', {
      vpc: jdVPC,
      instanceType: new ec2.InstanceType('t3a.medium'),
      machineImage: jdWindowImage,
      userData: controlServerUserData,
      keyName: 'jdCDK',
      vpcSubnets: {subnetType: SubnetType.PUBLIC},
      securityGroup: sgControlServerJd,
      role: ssmInstanceProfileRole,

    });
    Tags.of(jdInstance).add('Name', 'ControlServer');
    //</editor-fold>
  }
}
